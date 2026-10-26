"""Segly input adapter - segmentation PSD + zip -> the same hand-off step 4 produced for See-through.

segly.io returns a *pure partition* of the artwork: every layer's RGB is the original image and only
its alpha carries meaning (verified in `stepA`), the layers are mutually disjoint, and nothing is
inpainted. So this adapter has three jobs:

* A  read + clean  - verify the zip's `original.png` against M1, keep each layer's real body
  (largest blob + blobs >= 5% of it within 40px), drop the specks that blow the bounding boxes up,
  and lift the headphones out of `left_side_hair` into their own `neckwear` layer.
* B  map           - segly names -> psd2live names. Left/right is decided by the measured centroid
  side of each layer, because segly's own `left_*`/`right_*` prefixes are not self-consistent.
* C  fuse          - per output layer take segly's own pixels where it has them (sharpest edges) and
  fill only the parts segly left empty (eye/mouth holes and the bangs-hidden forehead in `face`,
  the head-hidden part of `back hair`, the neck) from the See-through rebuild in `fusion_source`.

The output is a `step4/layers` (native Parts) + `step4/eye_model` hand-off, so steps 5-8 run
unchanged. Everything is config driven; the See-through path is untouched.
"""
import json
import os
import zipfile

import cv2
import numpy as np

from . import repair, util


# ------------------------------------------------------------------ helpers

def _over(dst, src):
    """src over dst, in place; alpha stored 0..255."""
    sa = src[..., 3:4] / 255.0
    da = dst[..., 3:4] / 255.0
    out_a = sa + da * (1.0 - sa)
    w = np.where(out_a > 1e-6, sa / np.maximum(out_a, 1e-6), 0.0)
    dst[..., :3] = src[..., :3] * w + dst[..., :3] * (1.0 - w)
    dst[..., 3:4] = out_a * 255.0
    return dst


def _load_src_part(root, rel_dir, name, size):
    p = os.path.join(root, rel_dir, f'{name}.png')
    j = os.path.join(root, rel_dir, f'{name}.json')
    if not (os.path.exists(p) and os.path.exists(j)):
        return None
    img = util.load_rgba(p)
    o = util.read_json(j)['origin']
    out = np.zeros((size[1], size[0], 4), np.float32)
    y, x = int(o[1]), int(o[0])
    h, w = img.shape[:2]
    y1, x1 = min(y + h, size[1]), min(x + w, size[0])
    if y1 <= y or x1 <= x:
        return None
    out[y:y1, x:x1] = img[:y1 - y, :x1 - x]
    return out


def _crop(name, rgba):
    """Crop a full-canvas RGBA to its alpha bbox -> a Part (None when empty)."""
    ys, xs = np.where(rgba[..., 3] > 1)
    if not len(ys):
        return None
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    return util.Part(name, np.ascontiguousarray(rgba[y0:y1, x0:x1]), x0, y0)


def _bbox_of(mask):
    ys, xs = np.where(mask)
    if not len(ys):
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def _blob_info(mask):
    n, lab, stats, cent = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    out = []
    for i in range(1, n):
        out.append(dict(label=i, area=int(stats[i, cv2.CC_STAT_AREA]),
                        bbox=[int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP]),
                              int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT])],
                        centroid=[round(float(cent[i][0]), 1), round(float(cent[i][1]), 1)]))
    out.sort(key=lambda b: -b['area'])
    return out, lab


def keep_main_blobs(mask, min_ratio, max_dist, seed=None):
    """Largest blob plus every blob >= `min_ratio` of it and within `max_dist` px of it.

    `seed` (x, y) overrides "largest": the blob whose centroid is nearest the seed becomes the
    body. segly sometimes hands a layer a large blob that belongs elsewhere (the clasped hands at
    the bottom of the frame land in `left_eyelash`), and the rule applied to that blob would keep
    the junk and delete the real eyelash.
    """
    blobs, lab = _blob_info(mask)
    if not blobs:
        return np.zeros_like(mask), dict(blob_count=0, kept=0, kept_area=0, removed_area=0,
                                         kept_blobs=[], dropped_blobs=[])
    if seed is not None:
        main = min(blobs, key=lambda b: (b['centroid'][0] - seed[0]) ** 2 +
                   (b['centroid'][1] - seed[1]) ** 2)
        main_idx = blobs.index(main)
        blobs = [main] + blobs[:main_idx] + blobs[main_idx + 1:]
    else:
        main = blobs[0]
    main_mask = (lab == main['label'])
    dist = cv2.distanceTransform((~main_mask).astype(np.uint8), cv2.DIST_L2, 5)
    thr = max(min_ratio * main['area'], 1.0)
    keep = main_mask.copy()
    kept, dropped = [dict(area=main['area'], bbox=main['bbox'], centroid=main['centroid'],
                          distance_to_main=0.0)], []
    for b in blobs[1:]:
        sel = lab == b['label']
        d = float(dist[sel].min()) if sel.any() else 1e9
        ok = (b['area'] >= thr) and (d <= max_dist)
        (kept if ok else dropped).append(dict(area=b['area'], bbox=b['bbox'],
                                              centroid=b['centroid'],
                                              distance_to_main=round(d, 2)))
        if ok:
            keep |= sel
    return keep, dict(blob_count=len(blobs), kept=len(kept), kept_area=int(keep.sum()),
                      removed_area=int(mask.sum()) - int(keep.sum()),
                      min_area_ratio=min_ratio, max_distance_px=max_dist,
                      kept_blobs=kept[:8], dropped_blobs=dropped[:8],
                      dropped_blob_count=len(dropped))


# ------------------------------------------------------------------ A: read

def read_segly(cfg, log=print):
    c = cfg['segly']
    size = (int(c['canvas'][0]), int(c['canvas'][1]))
    W, H = size
    psd_size, layers = util.psd_pixel_layers(c['psd'])
    parts = {}
    order = []
    for l in layers:
        img = util.layer_rgba(l)
        full = np.zeros((H, W, 4), np.float32)
        x, y = int(l.bbox[0]), int(l.bbox[1])
        h, w = img.shape[:2]
        full[y:y + h, x:x + w] = img
        parts[l.name] = full
        order.append(l.name)
    manifest = None
    zip_original = None
    with zipfile.ZipFile(c['zip']) as z:
        names = set(z.namelist())
        if 'manifest.json' in names:
            manifest = json.loads(z.read('manifest.json').decode('utf-8'))
        for cand in ('original.png',):
            if cand in names:
                import io
                from PIL import Image
                zip_original = np.array(Image.open(io.BytesIO(z.read(cand))).convert('RGBA'),
                                        dtype=np.float32)
    log(f'segly: psd={psd_size} layers={len(order)} manifest_layers='
        f'{len(manifest["layers"]) if manifest else None}')
    return dict(size=size, psd_size=psd_size, parts=parts, order=order,
                manifest=manifest, zip_original=zip_original)


def step_a(cfg, out_root, data, log=print):
    """Read, verify and clean; lift the headphones out of the side hair."""
    c = cfg['segly']
    cl = c['clean']
    nw = c['neckwear']
    size = data['size']
    orig = util.load_rgba(c['original_png'])
    out = os.path.join(out_root, 'stepA')
    os.makedirs(out, exist_ok=True)

    verify = dict(zip_original_matches_original=bool(
        data['zip_original'] is not None and
        np.array_equal(data['zip_original'], orig)),
        original_size=list(size))
    if data['zip_original'] is not None:
        d = np.abs(data['zip_original'] - orig)
        verify['max_abs_diff_per_channel'] = [int(v) for v in d.reshape(-1, 4).max(axis=0)]
        verify['differing_pixels'] = int((d.sum(axis=2) > 0).sum())
    log(f'stepA: zip original.png == M1: {verify["zip_original_matches_original"]} '
        f'(diff {verify.get("differing_pixels")} px)')

    manifest_bounds = {l['name']: l.get('bounds') for l in (data['manifest'] or {}).get('layers', [])}

    # ---- headphones first: the two cups sit ~39px apart, so the "within 40px of the main blob"
    # cleaning rule would drop one of them. Split them off the raw side hair, then clean each half.
    src = nw['source_layer']
    raw = data['parts'][src]
    srcmask = raw[..., 3] > int(cl['alpha_threshold'])
    blobs, lab = _blob_info(srcmask)
    moved = np.zeros_like(srcmask)
    detail = []
    for b in blobs:
        sel = lab == b['label']
        rgb = raw[..., :3][sel] / 255.0
        mx = rgb.max(axis=1)
        mn = rgb.min(axis=1)
        sat = float(np.median((mx - mn) / np.maximum(mx, 1e-6)))
        lum = float(np.median(rgb.mean(axis=1)) * 255.0)
        cy = b['centroid'][1]
        is_nw = (b['area'] >= int(nw['min_area']) and cy > float(nw['min_centroid_y'])
                 and float(nw['min_lum']) <= lum <= float(nw['max_lum'])
                 and sat <= float(nw['max_saturation']))
        detail.append(dict(area=b['area'], centroid=b['centroid'], mean_lum=round(lum, 1),
                           saturation=round(sat, 3), bbox=b['bbox'], taken_as_neckwear=bool(is_nw)))
        if is_nw:
            moved |= sel
    split = {src: raw.copy()}
    split[src][..., 3] = np.where(moved, 0.0, raw[..., 3])
    nw_raw = np.zeros_like(raw)
    nw_raw[..., :3] = raw[..., :3]
    nw_raw[..., 3] = np.where(moved, raw[..., 3], 0.0)
    split[nw['name']] = nw_raw
    neckwear = dict(name=nw['name'], moved_pixels=int(moved.sum()), source_layer=src,
                    criteria=dict(min_area=int(nw['min_area']),
                                  centroid_y_gt=float(nw['min_centroid_y']),
                                  lum_range=[float(nw['min_lum']), float(nw['max_lum'])],
                                  max_saturation=float(nw['max_saturation'])),
                    blobs=detail, order='split before cleaning (one cup is >40px from the hair body)')
    log(f'stepA: neckwear {int(moved.sum())}px from {src} '
        f'({sum(d["taken_as_neckwear"] for d in detail)}/{len(detail)} blobs)')

    per_layer, cleaned = {}, {}
    tiles_before, tiles_after, labels = [], [], []
    for name in list(data['order']) + [nw['name']]:
        full = split.get(name)
        if full is None:
            full = data['parts'].get(name)
        if full is None:
            continue
        mask = full[..., 3] > int(cl['alpha_threshold'])
        seed = (cl.get('main_blob_seed') or {}).get(name)
        keep, info = keep_main_blobs(mask, float(cl['min_area_ratio']),
                                     float(cl['max_distance_px']), seed=seed)
        info['main_blob_seed'] = list(seed) if seed else None
        out_img = np.zeros_like(full)
        out_img[..., :3] = full[..., :3]
        out_img[..., 3] = np.where(keep, full[..., 3], 0.0)
        cleaned[name] = out_img
        kept_px = int((out_img[..., 3] > 127).sum())
        info.update(name=name, pixels_before=int(mask.sum()), pixels_after=kept_px,
                    removed_px=int(mask.sum()) - kept_px,
                    manifest_bounds=manifest_bounds.get(name))
        if mask.any():
            ys, xs = np.where(mask)
            info['actual_bbox_before'] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
        if kept_px:
            ys, xs = np.where(out_img[..., 3] > 127)
            info['actual_bbox_after'] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
        per_layer[name] = info
        tiles_before.append(util.thumb(full, 150, checker=True))
        tiles_after.append(util.thumb(out_img, 150, checker=True))
        labels.append(f'{name}\n{info["pixels_before"]}->{kept_px}px ({info["blob_count"]}blob)')
    per_layer[src]['removed_to_neckwear'] = int(moved.sum())

    # ---- verify the four "known characteristics" of segly on the real data
    H, W = size[1], size[0]
    names = [n for n in data['order'] if n in data['parts']]
    masks = {n: data['parts'][n][..., 3] > 127 for n in names}
    overlaps = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            ov = int((masks[names[i]] & masks[names[j]]).sum())
            if ov:
                overlaps.append(dict(a=names[i], b=names[j], pixels=ov))
    rgb_delta = {}
    for n in names:
        m = masks[n]
        if m.sum():
            rgb_delta[n] = round(float(np.abs(data['parts'][n][..., :3][m] -
                                               orig[..., :3][m]).mean()), 3)
    silhouette = orig[..., 3] > 127
    bg = masks['background']
    fc = cleaned['face'][..., 3] > 127
    _face_bottom = int(np.where(fc.any(axis=1))[0].max()) if fc.any() else None
    fcols = np.where(fc.any(axis=0))[0]
    # bbox bloat: how little of a layer's own box actually holds pixels
    bloat = {}
    for n in names:
        m = masks[n]
        if not m.any():
            continue
        ys, xs = np.where(m)
        bw, bh = int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)
        bloat[n] = dict(bbox=[int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
                        bbox_area=int(bw * bh), pixels=int(m.sum()),
                        fill_pct=round(100.0 * float(m.sum()) / max(bw * bh, 1), 2))
    worst_bloat = sorted(bloat.items(), key=lambda kv: kv[1]['fill_pct'])[:8]
    # the artwork's own neck skin under the chin: the place a neck layer must cover
    corridor = np.zeros((H, W), bool)
    neck_cover = 0
    if _face_bottom is not None and len(fcols):
        y0, y1 = max(_face_bottom - 4, 0), min(_face_bottom + 90, H)
        x0, x1 = int(fcols.min()), int(fcols.max()) + 1
        rgb = orig[..., :3]
        mx, mn = rgb.max(axis=2), rgb.min(axis=2)
        chroma = (mx - mn) / np.maximum(mx, 1.0)
        warm = (rgb[..., 0] >= rgb[..., 1]) & (rgb[..., 1] >= rgb[..., 2])
        # R-G separates skin (neck ~46) from the knit turtleneck (~14), same test as repair.rebuild_neck
        red_green = rgb[..., 0] - rgb[..., 1]
        skin = ((orig[..., 3] / 255.0 > 0.9) & (chroma > 0.05) & (chroma < 0.22) & warm &
                (red_green > 20) & (mx > 90))
        corridor[y0:y1, x0:x1] = skin[y0:y1, x0:x1]
        neck_cover = int((masks['neck'] & corridor).sum())
    eye_region = np.zeros((H, W), bool)
    eye_region[267:621, 342:707] = True
    mouth_region = np.zeros((H, W), bool)
    mouth_region[490:545, 465:545] = True
    forehead = np.zeros((H, W), bool)
    forehead[180:300, 420:620] = True
    face_a = data['parts']['face'][..., 3] > 127
    eye_layers = ['left_iris', 'right_iris', 'left_eye_white', 'right_eye_white',
                  'left_eyelash', 'right_eyelash']
    lip_layers = ['upper_lip', 'lower_lip', 'mouth_interior']
    char = dict(
        partition_disjoint=len(overlaps) == 0,
        max_pairwise_overlap_px=max((o['pixels'] for o in overlaps), default=0),
        overlaps=overlaps[:10],
        rgb_is_original=dict(per_layer_mean_abs_diff=rgb_delta,
                             note='layer RGB == M1 where the layer is opaque -> pure segmentation'),
        face_is_a_hole_not_a_copy=dict(
            face_px_eye_region=int((face_a & eye_region).sum()),
            eye_layers_px_in_eye_region=int(sum((data['parts'][n][..., 3] > 127)[eye_region].sum()
                                                for n in eye_layers)),
            face_overlap_with_eye_layers=int(sum((face_a & (data['parts'][n][..., 3] > 127)).sum()
                                                 for n in eye_layers)),
            face_overlap_with_lips=int(sum((face_a & (data['parts'][n][..., 3] > 127)).sum()
                                           for n in lip_layers)),
            face_dark_px_in_eye_region=int(((orig[..., :3].mean(axis=2) < 110) & face_a &
                                            eye_region).sum()),
            note='face keeps the drawn eyelid/eye-line strokes (dark px) and has holes where the '
                 'eye/lip layers are: it is not carrying a second copy of the eyes/mouth'),
        forehead_under_bangs_empty=dict(
            forehead_px=int(forehead.sum()), artwork_opaque=int((silhouette & forehead).sum()),
            face_px=int((face_a & forehead).sum()),
            front_bangs_px=int(((data['parts']['front_bangs'][..., 3] > 127) & forehead).sum())),
        bbox_bloat=dict(
            note='a speck far from the body makes the layer box huge while holding almost no pixels',
            worst=[[n, v] for n, v in worst_bloat]),
        background_has_character_pixels=dict(
            background_px=int(bg.sum()),
            inside_silhouette_px=int((bg & silhouette).sum()),
            bbox_of_inside=(_bbox_of(bg & silhouette) if (bg & silhouette).any() else None)),
        head_layer=dict(pixels=int((data['parts']['head'][..., 3] > 127).sum())),
        neck_under_chin=dict(
            neck_px=int((data['parts']['neck'][..., 3] > 127).sum()),
            face_bottom_y=_face_bottom,
            face_bottom_source='cleaned face main blob',
            neck_px_below_face_bottom=(int((data['parts']['neck'][..., 3] > 127)[_face_bottom:].sum())
                                       if _face_bottom is not None else None),
            corridor_pixels=int(corridor.sum()),
            corridor_covered_by_raw_neck=int(neck_cover),
            corridor_covered_pct=round(100.0 * neck_cover / max(int(corridor.sum()), 1), 1),
            corridor_note='bare neck skin below the chin (R-G>20 excludes the knit turtleneck); '
                          'the character wears a turtleneck right under the chin, so there is very '
                          'little bare neck in the artwork'),
    )

    # ---- figures
    util.montage([t for pair in zip(tiles_before, tiles_after) for t in pair], cols=6,
                 cell=(150, 150), labels=[f'before {n}' if i % 2 == 0 else f'after {n}'
                                          for i, n in enumerate(labels)]).save(
        os.path.join(out, 'check_stepA_clean.png'))
    nwm = np.zeros((size[1], size[0], 3), np.float32)
    nwm[..., 0] = moved * 255
    nwm[..., 1] = (cleaned[src][..., 3] > 127) * 120
    util.montage([util.thumb(data['parts'][src], 260), util.thumb(cleaned[src], 260),
                  util.thumb(np.concatenate([nwm, np.full(nwm.shape[:2] + (1,), 255.0, np.float32)],
                                            axis=2), 260),
                  util.thumb(cleaned[nw['name']], 260)],
                 cols=4, cell=(260, 390),
                 labels=['left_side_hair raw', 'after split+clean (hair only)',
                         'red = moved to neckwear / green = kept hair', 'neckwear layer']).save(
        os.path.join(out, 'check_stepA_neckwear.png'))

    metrics = dict(step='stepA', verify=verify, clean_config=dict(cl), layers=per_layer,
                   neckwear=neckwear,
                   characteristics=char,
                   totals=dict(pixels_before=sum(v['pixels_before'] for v in per_layer.values()),
                               pixels_after=sum(v['pixels_after'] for v in per_layer.values()),
                               removed=sum(v['removed_px'] for v in per_layer.values())),
                   figures=['check_stepA_clean.png', 'check_stepA_neckwear.png'])
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    return cleaned, metrics


# ------------------------------------------------------------------ B: map

def side_of(centroid_x, mid, side_left_is_image_right=True):
    """psd2live's `l` = the character's own left = the right side of a front-facing image."""
    image_right = centroid_x > mid
    if side_left_is_image_right:
        return 'l' if image_right else 'r'
    return 'r' if image_right else 'l'


def step_b(cfg, out_root, data, cleaned, log=print):
    c = cfg['segly']
    size = data['size']
    W = size[0]
    mid = W / 2.0
    mapping = c['mapping']
    out = os.path.join(out_root, 'stepB')
    os.makedirs(out, exist_ok=True)
    mapped, rows, assign = {}, [], {}
    for segly_name in list(data['order']) + [n for n in cleaned if n not in data['order']]:
        if segly_name not in cleaned:
            continue
        spec = mapping.get(segly_name)
        if spec is None:
            rows.append(dict(segly=segly_name, out=None, action='ignored (not in mapping)',
                             pixels=int((cleaned[segly_name][..., 3] > 127).sum())))
            continue
        if isinstance(spec, str):
            spec = {'name': spec, 'side': 'none'}
        name = spec['name']
        side = spec.get('side', 'none')
        mask = cleaned[segly_name][..., 3] > 127
        if mask.sum():
            ys, xs = np.where(mask)
            cx = float(xs.mean())
        else:
            cx = mid
        if side == 'auto':
            s = side_of(cx, mid, c.get('side_left_is_image_right', True))
            name = f'{name}-{s}'
            named_side = None
            low = segly_name.lower()
            if low.startswith('left'):
                named_side = 'l'
            elif low.startswith('right'):
                named_side = 'r'
            rows.append(dict(segly=segly_name, out=name, centroid_x=round(cx, 1),
                             image_side='image right' if cx > mid else 'image left',
                             segly_prefix=named_side, matches_psd2live=(named_side == s),
                             action='mapped',
                             pixels=int(mask.sum())))
        else:
            rows.append(dict(segly=segly_name, out=name, centroid_x=round(cx, 1),
                             action=spec.get('why', 'mapped'),
                             pixels=int(mask.sum())))
        mapped.setdefault(name, np.zeros((size[1], size[0], 4), np.float32))
        _over(mapped[name], cleaned[segly_name])
        assign[segly_name] = name

    tiles, labels = [], []
    for row in rows:
        if row['out'] is None:
            continue
        img = mapped[row['out']]
        tiles.append(util.thumb(img, 140))
        labels.append(f'{row["segly"]}\n-> {row["out"]}')
    if tiles:
        util.montage(tiles, cols=7, cell=(140, 210), labels=labels).save(
            os.path.join(out, 'check_stepB_mapping.png'))
    metrics = dict(step='stepB', rows=rows, outputs=sorted(mapped.keys()),
                   assign=assign, figures=['check_stepB_mapping.png'])
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    log(f'stepB: {len(mapped)} output layers from {len(data["order"])} segly layers')
    return mapped, metrics, assign


# ------------------------------------------------------------------ C: fuse

def _alpha(rgba):
    return rgba[..., 3] / 255.0


def _fuse(dst, other, cfg, forbid=None):
    """Fill only where `dst` has no pixels: segly keeps its own artwork, the source fills the rest.

    `forbid` (0..1 full canvas) is the coverage of the *other* stacked segly layers: a fill may not
    paint over a pixel segly gave to a different layer (that is how the face fill used to put skin
    over the ear/back-hair the artwork draws).
    """
    before = int((_alpha(dst) > 0.5).sum())
    if other is None:
        return dict(added_pixels=0, segly_pixels=before, inpainted_pixels=0,
                    inpainted_pct=0.0, segly_pct=100.0 if before else None)
    sa, da = _alpha(other), _alpha(dst)
    add = (sa > 0.5) & (da <= 0.5)
    if forbid is not None:
        add &= (forbid <= 0.5)
    dst[..., :3] = np.where(add[..., None], other[..., :3], dst[..., :3])
    dst[..., 3] = np.maximum(dst[..., 3], np.where(add, other[..., 3], 0.0))
    total = int((_alpha(dst) > 0.5).sum())
    added = int(add.sum())
    blocked = int(((sa > 0.5) & (da <= 0.5)).sum()) - added if forbid is not None else 0
    return dict(added_pixels=added, segly_pixels=before, inpainted_pixels=added,
                total_pixels=total, blocked_by_other_layers=blocked,
                segly_pct=round(100.0 * before / max(total, 1), 1),
                inpainted_pct=round(100.0 * added / max(total, 1), 1))


def step_c(cfg, out_root, data, cleaned, mapped, assign, log=print):
    c = cfg['segly']
    size = data['size']
    src_root = c['fusion_source']
    out = os.path.join(out_root, 'stepC')
    os.makedirs(out, exist_ok=True)

    def src(rel_dir, name):
        return _load_src_part(src_root, rel_dir, name, size)

    def first(*cands):
        for x in cands:
            if x is not None:
                return x
        return None

    fusion = {}
    # segly's own coverage, taken before any fill: a pixel it assigned to *some* layer must not be
    # handed to another layer's fill, and one it lost (speck cleaning, a dropped `head`/`background`)
    # has to be put back by the residual layer below.
    own_cov = np.zeros((size[1], size[0]), np.float32)
    for n in c['stack_order']:
        if n in mapped:
            np.maximum(own_cov, mapped[n][..., 3] / 255.0, out=own_cov)

    absorbed_cfg = c.get('fusion_absorbed') or {}

    def forbid_cov(out_name):
        """Coverage of the segly layers a fill for `out_name` must NOT paint over (None = no rule)."""
        if out_name not in absorbed_cfg:
            return None
        absorb = set(absorbed_cfg.get(out_name) or [])
        cov = np.zeros((size[1], size[0]), np.float32)
        for sname, target in assign.items():
            if sname in absorb or target == out_name:
                continue
            if sname in cleaned:
                np.maximum(cov, cleaned[sname][..., 3] / 255.0, out=cov)
        return cov

    # ---- face: segly skin + the See-through rebuild's forehead / eye / mouth holes
    face = mapped.get('face')
    if face is not None:
        r4face = first(src('step6/layers', 'face'), src('step4/layers', 'face'))
        fusion['face'] = _fuse(face, r4face, c, forbid_cov('face'))
    # ---- back hair: segly's visible part + the rebuild's behind-the-head part
    bh = mapped.get('back hair')
    if bh is not None:
        r4bh = first(src('step6/layers', 'back hair'), src('step4/layers', 'back hair'))
        fusion['back hair'] = _fuse(bh, r4bh, c, forbid_cov('back hair'))
    # ---- neck: solid, from the artwork's own neck rebuilt with the step-6 rule
    neck = mapped.get('neck')
    if neck is None:
        neck = np.zeros((size[1], size[0], 4), np.float32)
        mapped['neck'] = neck
    r4neck = first(src('step6/layers', 'neck'), src('step4/layers', 'neck'))

    # ---- eye model for step 5: segly's own visible slivers (they say where the iris is really
    #      visible) merged per feature; the extra iris circle comes from the rebuild
    eye_model, eye_extra, eye_stats = {}, {}, {}
    for key, srcs in (('irides', ['left_iris', 'right_iris']),
                      ('eyewhite', ['left_eye_white', 'right_eye_white']),
                      ('eyelash', ['left_eyelash', 'right_eyelash'])):
        acc = np.zeros((size[1], size[0], 4), np.float32)
        got = 0
        for s in srcs:
            if s in cleaned:
                _over(acc, cleaned[s])
                got += int((cleaned[s][..., 3] > 127).sum())
        eye_model[key] = acc
        eye_stats[key] = dict(segly_layers=srcs, pixels=got)
    for key in ('irides',):
        acc = np.zeros((size[1], size[0], 4), np.float32)
        for n in (f'{key}-l', f'{key}-r'):
            p = src('step5/layers', n)
            if p is not None:
                _over(acc, p)
        eye_extra[key] = acc
        eye_stats[key]['extra_pixels'] = int((acc[..., 3] > 127).sum())

    # ---- mouth ROI box: needed by step 6's variant builder as the fallback box
    mouth_roi = list(c['mouth_roi']) if c.get('mouth_roi') else None
    if mouth_roi is None:
        mouth_box_src = first(src('step6/layers', 'mouth close'), src('step4/layers', 'mouth'))
        if mouth_box_src is not None:
            ys, xs = np.where(mouth_box_src[..., 3] > 127)
            mouth_roi = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]

    # ---- assemble the stack in the configured order, then rebuild the neck
    order = [n for n in c['stack_order'] if n in mapped]
    stack = [p for p in (_crop(n, mapped[n]) for n in order) if p is not None]
    # a placeholder 'mouth' part carrying the ROI box (step 6 drops it, the variant builder reads it)
    if mouth_roi is not None:
        x0, y0, x1, y1 = mouth_roi
        ph = np.zeros((y1 - y0, x1 - x0, 4), np.float32)
        ph[..., :3] = 255.0
        ph[..., 3] = 255.0
        base = util.Part('mouth', ph, x0, y0)
        idx = next((i for i, p in enumerate(stack) if p.name == 'nose'), len(stack))
        stack.insert(idx + 1, base)
    neck_info = dict(done=False)
    if c.get('neck_rebuild', {}).get('enabled'):
        stack, neck_info = repair.rebuild_neck(stack, util.load_rgba(c['original_png']),
                                               c['neck_rebuild'], log=log)
        if neck_info.get('enabled'):
            new_neck = next(p for p in stack if p.name == 'neck')
            full = np.zeros((size[1], size[0], 4), np.float32)
            full[new_neck.top:new_neck.top + new_neck.size[1],
                 new_neck.left:new_neck.left + new_neck.size[0]] = new_neck.img
            fusion['neck'] = _fuse(mapped['neck'], full, c)
            fusion['neck'] = _fuse(full, mapped['neck'], c)
            fusion['neck']['rule'] = ('union(segly neck, repair.rebuild_neck) - segly assigns the '
                                      'jaw/under-chin skin to `neck` too, so both must be kept; '
                                      f'above_chin_px={c["neck_rebuild"].get("above_chin_px")}')
            p = _crop('neck', full)
            if p is not None:
                stack = [p if q.name == 'neck' else q for q in stack]
        else:
            # fall back to the See-through rebuild's neck (same rule, its own run)
            fusion['neck'] = _fuse(mapped['neck'], r4neck, c)
            fusion['neck']['rule'] = 'fallback: fused from the See-through rebuild'
            neck_info['fallback'] = 'fused from the See-through rebuild'
    else:
        fusion['neck'] = _fuse(mapped['neck'], r4neck, c)

    # ---- residual: artwork pixels no layer covers. Cleaning drops specks, `head` and
    # `background` are not stacked, and a layer can be narrower than the pixels segly gave it;
    # without this the big fused `back hair` shows through the gaps (dark hair over jaw skin).
    resid_cfg = c.get('residual') or {}
    if resid_cfg.get('enabled', True):
        oa = _alpha(util.load_rgba(c['original_png']))
        cov = own_cov
        excl = np.zeros((size[1], size[0]), bool)
        for ex in resid_cfg.get('exclude_boxes', []):
            x0, y0, x1, y1 = [int(v) for v in ex]
            excl[y0:y1, x0:x1] = True
        em = int(resid_cfg.get('eye_margin_px', 26))
        eye_union = np.zeros((size[1], size[0]), bool)
        for key in ('irides', 'eyelash', 'eyewhite'):
            eye_union |= eye_model[key][..., 3] > 127
        if eye_union.any():
            k = 2 * em + 1
            excl |= cv2.dilate(eye_union.astype(np.uint8), np.ones((k, k), np.uint8)) > 0
        if mouth_roi is not None:
            x0, y0, x1, y1 = mouth_roi
            m = int(resid_cfg.get('mouth_margin_px', 12))
            excl[max(y0 - m, 0):y1 + m, max(x0 - m, 0):x1 + m] = True
        resid = (oa > 0.5) & (cov < 0.5) & (~excl)
        blobs, lab = _blob_info(resid)
        min_area = int(resid_cfg.get('min_area', 200))
        keep = np.zeros_like(resid)
        kept = []
        for b in blobs:
            if b['area'] < min_area:
                continue
            keep |= (lab == b['label'])
            kept.append(b)
        fusion['residual'] = dict(
            uncovered_pixels=int(resid.sum()), kept_pixels=int(keep.sum()),
            kept_blobs=len(kept), min_area=min_area,
            boxes=[b['bbox'] for b in sorted(kept, key=lambda b: -b['area'])[:8]])
        if keep.any():
            art = util.load_rgba(c['original_png'])
            soft = cv2.GaussianBlur(keep.astype(np.float32), (0, 0),
                                    float(resid_cfg.get('feather_px', 1.0)))
            soft = np.maximum(soft, keep.astype(np.float32))
            rp = _crop(resid_cfg.get('name', 'objects'),
                       np.concatenate([art[..., :3], (soft * art[..., 3])[..., None]], axis=2))
            if rp is not None:
                anchor = resid_cfg.get('insert_before', 'face')
                i = next((k for k, q in enumerate(stack) if q.name == anchor), len(stack))
                stack.insert(i, rp)
                fusion['residual']['layer'] = dict(name=rp.name, bbox=[rp.left, rp.top,
                                                                       rp.left + rp.size[0],
                                                                       rp.top + rp.size[1]],
                                                   pixels=int((rp.img[..., 3] > 127).sum()))
                log(f'segly: residual layer {rp.name} {int((rp.img[..., 3] > 127).sum())}px '
                    f'({len(kept)} blobs) inserted before {anchor}')

    # ---- figures: fusion coverage per layer
    tiles, labels = [], []
    for p in stack:
        full = np.zeros((size[1], size[0], 4), np.float32)
        full[p.top:p.top + p.size[1], p.left:p.left + p.size[0]] = p.img
        tiles.append(util.thumb(full, 160))
        labels.append(f'{p.name}')
    util.montage(tiles, cols=6, cell=(160, 240), labels=labels).save(
        os.path.join(out, 'check_stepC_layers.png'))

    util.save_parts(stack, os.path.join(out_root, 'step4', 'layers'))
    eye_parts = [p for p in (_crop(k, eye_model[k]) for k in ('eyewhite', 'irides', 'eyelash'))
                 if p is not None]
    util.save_parts(eye_parts, os.path.join(out_root, 'step4', 'eye_model'))
    util.save_parts([p for p in (_crop('irides', eye_extra['irides']),) if p is not None],
                    os.path.join(out_root, 'step4', 'eye_model_extra'))

    rows = []
    for p in stack:
        full = np.zeros((size[1], size[0], 4), np.float32)
        full[p.top:p.top + p.size[1], p.left:p.left + p.size[0]] = p.img
        a = full[..., 3] / 255.0
        rows.append(dict(layer=p.name, alpha_pixels=int((a > 0.5).sum()),
                         bbox=[p.left, p.top, p.left + p.size[0], p.top + p.size[1]]))
    metrics = dict(step='stepC', stack_order=order, layers=rows,
                   fusion=fusion, eye_model=eye_stats, neck=neck_info,
                   mouth_roi=mouth_roi, source_root=src_root,
                   figures=['check_stepC_layers.png'])
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    return stack, eye_model, eye_extra, metrics


# ------------------------------------------------------------------ driver

def run(cfg, out_root, log=print):
    data = read_segly(cfg, log=log)
    cleaned, a = step_a(cfg, out_root, data, log=log)
    mapped, b, assign = step_b(cfg, out_root, data, cleaned, log=log)
    stack, eye_model, eye_extra, c = step_c(cfg, out_root, data, cleaned, mapped, assign, log=log)

    # step 3 is only consumed for its reference colour diff; segly needs no mapping at all
    orig = util.load_rgba(cfg['segly']['original_png'])
    flat = np.zeros_like(orig)
    for p in stack:
        full = np.zeros_like(orig)
        full[p.top:p.top + p.size[1], p.left:p.left + p.size[0]] = p.img
        _over(flat, full)
    diff, gate = util.gated_diff(orig, flat, 0.85)
    os.makedirs(os.path.join(out_root, 'step3'), exist_ok=True)
    util.write_json(dict(
        step=3, adapter='segly',
        original_size=list(data['size']),
        formula=dict(s=1.0, padx=0.0, pady=0.0, expected=dict(s=1.0)),
        formula_result=dict(mean_abs_color_diff=diff, gated_pixels=int(gate.sum()),
                            note='segly output is already at the artwork resolution - identity mapping'),
        search_result=dict(improvement_pct=0.0, significant=False, best=dict(scale=1.0, dx=0.0, dy=0.0),
                           best_result=dict(mean_abs_color_diff=diff), grid={}, evaluations=0, top10=[]),
        figures=[]), os.path.join(out_root, 'step3', 'metrics.json'))

    metrics = dict(step='segly', canvas=list(data['size']),
                   original_matches_m1=a['verify']['zip_original_matches_original'],
                   clean=a['totals'], neckwear=a['neckwear'],
                   mapping=b['rows'], outputs=b['outputs'],
                   fusion=c['fusion'], eye_model=c['eye_model'],
                   flat_vs_original_mean_abs_color_diff=diff,
                   figures=a['figures'] + b['figures'] + c['figures'])
    util.write_json(metrics, os.path.join(out_root, 'segly.json'))
    log(f'segly: done, {len(stack)} layers -> step4/layers; '
        f'union flat diff vs artwork {diff:.3f}')
    return metrics
