"""Seam repair on the assembled stack: close lost pixels and the chin/collar colour step.

Two defects the flattened model shows against the artwork, both measured here before and after:

* holes - the artwork is opaque, the composite is not. Inside the silhouette those are pixels the
  reconstruction dropped (a gap between two parts' alpha); they are filled from the artwork into
  the neighbouring part, preferring the neck.
* chin/collar step - the model's collar shadow reaches higher than the artwork's collar, so a skin
  band between the chin and the collar comes out dark. Where the artwork is skin and the model is
  much darker, the artwork's skin is put back into the neck and the collar's alpha is pulled away.
"""
import cv2
import numpy as np

from . import util


def interior_transparency(composite_alpha, level=0.5):
    """Transparent pixels enclosed by the silhouette (not reachable from the image border)."""
    solid = (composite_alpha >= level).astype(np.uint8)
    h, w = solid.shape
    ff = np.zeros((h + 2, w + 2), np.uint8)
    grown = solid.copy()
    cv2.floodFill(grown, ff, (0, 0), 1)
    return (grown == 0)


def region_owner(parts, xy, priority):
    """Name of the most specific part whose box holds this point (head parts listed first)."""
    x, y = xy
    by_name = {p.name: p for p in parts}
    for name in priority:
        p = by_name.get(name)
        if p is None:
            continue
        if p.left <= x < p.left + p.size[0] and p.top <= y < p.top + p.size[1]:
            return name
    for p in parts:
        if p.left <= x < p.left + p.size[0] and p.top <= y < p.top + p.size[1]:
            return p.name
    return 'outside-layers'


def hole_report(orig, flat, parts, priority):
    """Hole pixels (artwork opaque, composite not) split by region and by enclosure."""
    oa = orig[..., 3] / 255.0
    fa = flat[..., 3] / 255.0
    hole = (oa > 0.5) & (fa < 0.5)
    enclosed = interior_transparency(fa)
    blob_list, lab = util.blobs(hole, min_area=1)
    regions = {}
    for b in blob_list:
        owner = region_owner(parts, b['centroid'], priority)
        r = regions.setdefault(owner, dict(pixels=0, interior_pixels=0, blobs=0,
                                           largest_blob=0, largest_bbox=None))
        sel = lab == b['label']
        r['pixels'] += b['area']
        r['interior_pixels'] += int((sel & enclosed).sum())
        r['blobs'] += 1
        if b['area'] > r['largest_blob']:
            r['largest_blob'] = b['area']
            r['largest_bbox'] = b['bbox']
    return dict(
        total_pixels=int(hole.sum()),
        interior_pixels=int((hole & enclosed).sum()),
        edge_pixels=int((hole & ~enclosed).sum()),
        blob_count=len(blob_list),
        regions=regions,
        _hole=hole,
        _enclosed=enclosed,
    )


def _paint(part, mask, orig, feather):
    """Add the artwork's pixels to `part` inside a full-canvas mask (extending the part if needed)."""
    soft = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), feather) if feather > 0 else mask.astype(np.float32)
    # feather outward only: inside the mask the artwork's own alpha must survive a 1px blob
    soft = np.maximum(np.clip(soft, 0, 1), mask.astype(np.float32))
    ys, xs = np.where(soft > 0.02)
    if not len(ys):
        return part, 0
    H, W = orig.shape[:2]
    x0 = min(int(xs.min()), part.left)
    y0 = min(int(ys.min()), part.top)
    x1 = max(int(xs.max()) + 1, part.left + part.size[0])
    y1 = max(int(ys.max()) + 1, part.top + part.size[1])
    canvas = np.zeros((y1 - y0, x1 - x0, 4), np.float32)
    oy, ox = part.top - y0, part.left - x0
    canvas[oy:oy + part.size[1], ox:ox + part.size[0]] = part.img
    new_a = (orig[y0:y1, x0:x1, 3:4] / 255.0) * soft[y0:y1, x0:x1, None]
    have_a = canvas[..., 3:4] / 255.0
    take = new_a > 0.5   # the artwork's own alpha never quite reaches 1.0 (254/255)
    canvas[..., :3] = np.where(take, orig[y0:y1, x0:x1, :3], canvas[..., :3])
    canvas[..., 3:4] = np.maximum(have_a, new_a) * 255.0
    return util.Part(part.name, canvas, x0, y0), int((new_a > 0.02).sum())


def fill_holes(stack, orig, cfg, log=print):
    """Fill interior holes from the artwork into the part that should have covered them.

    Repeats, because a fill can expose a neighbour (a 1px gap whose donor gets its own rounding
    back): the loop ends when no interior hole is left, or after `passes` rounds.
    """
    if not cfg.get('enabled', False):
        return stack, dict(skipped=True)
    passes = int(cfg.get('passes', 3))
    total = []
    last = None
    for _ in range(passes):
        stack, res = _fill_holes_once(stack, orig, cfg, log=log)
        if res.get('skipped'):
            return stack, res
        total.extend(res.get('fills') or [])
        last = res
        after = res.get('after_saved_png') or res.get('after') or {}
        if after.get('interior_pixels', 0) == 0:
            break
    if last is None:
        return stack, dict(skipped=True)
    last['fills'] = total
    return stack, last


def _fill_holes_once(stack, orig, cfg, log=print):
    c = cfg
    H, W = orig.shape[:2]
    flat = util.composite(stack, (W, H))
    rep = hole_report(orig, flat, stack, ['eyewhite-l', 'eyewhite-r', 'irides-l', 'irides-r',
                                             'eyelash-l', 'eyelash-r', 'eyebrow', 'mouth',
                                             'mouth close', 'mouth open', 'nose', 'ears',
                                             'earwear', 'face', 'neck', 'neckwear', 'topwear',
                                             'handwear', 'back hair', 'front hair'])
    enclosed = rep['_enclosed']
    hole = rep['_hole'] & enclosed
    fills = []
    if not hole.any():
        rep.pop('_hole'), rep.pop('_enclosed')
        return stack, dict(before=rep, fills=[])
    blob_list, lab = util.blobs(hole, min_area=int(c['min_area']))
    by_name = {p.name: i for i, p in enumerate(stack)}
    for b in blob_list:
        sel = (lab == b['label']).astype(np.uint8)
        ring = cv2.dilate(sel, np.ones((13, 13), np.uint8)) > 0
        donor = None
        for pref in c['donor_preference']:
            i = by_name.get(pref)
            if i is None:
                continue
            p = stack[i]
            a = np.zeros((H, W), np.float32)
            x0, y0 = max(p.left, 0), max(p.top, 0)
            x1, y1 = min(p.left + p.size[0], W), min(p.top + p.size[1], H)
            if x1 > x0 and y1 > y0:
                a[y0:y1, x0:x1] = p.img[y0 - p.top:y1 - p.top, x0 - p.left:x1 - p.left, 3] / 255.0
            if (a[ring] > 0.5).sum() > 0.2 * ring.sum():
                donor = i
                break
        if donor is None:
            # nothing preferred touches it: take whatever part is closest to the gap
            best, best_cov = None, 0.0
            for i, p in enumerate(stack):
                a = np.zeros((H, W), np.float32)
                ax0, ay0 = max(p.left, 0), max(p.top, 0)
                ax1, ay1 = min(p.left + p.size[0], W), min(p.top + p.size[1], H)
                if ax1 > ax0 and ay1 > ay0:
                    a[ay0:ay1, ax0:ax1] = p.img[ay0 - p.top:ay1 - p.top, ax0 - p.left:ax1 - p.left, 3] / 255.0
                cov = float((a[ring] > 0.5).sum()) / max(int(ring.sum()), 1)
                if cov > best_cov:
                    best, best_cov = i, cov
            if best is None or best_cov <= 0.0:
                continue
            donor = best
        stack[donor], added = _paint(stack[donor], sel.astype(bool), orig, 1.0)
        fills.append(dict(donor=stack[donor].name, pixels=b['area'], bbox=b['bbox'],
                          added_pixels=added))
        log(f'repair: hole {b["area"]}px {b["bbox"]} -> {stack[donor].name}')
    flat2 = util.composite(stack, (W, H))
    after = hole_report(orig, flat2, stack, [p.name for p in stack])
    after.pop('_hole'), after.pop('_enclosed')
    rounded = np.clip(flat2, 0, 255).astype(np.uint8).astype(np.float32)
    after_png = hole_report(orig, rounded, stack, [p.name for p in stack])
    after_png.pop('_hole'), after_png.pop('_enclosed')
    rep.pop('_hole'), rep.pop('_enclosed')
    return stack, dict(before=rep, after=after, after_saved_png=after_png, fills=fills)


def repair_chin_collar(stack, orig, cfg, log=print):
    """Put the artwork's skin back between the chin and the collar where the model drew shadow."""
    if not cfg.get('enabled', False):
        return stack, dict(skipped=True)
    H, W = orig.shape[:2]
    by_name = {p.name: p for p in stack}
    face, neck, top = by_name.get('face'), by_name.get(cfg['donor_layer']), by_name.get('topwear')
    if face is None or neck is None or top is None:
        return stack, dict(skipped=True, reason='face/neck/topwear missing')
    donors = [by_name[n] for n in cfg.get('layers_top_down', []) if n in by_name] or [neck]
    face_bottom = face.top + face.size[1]
    y0 = max(int(face_bottom + cfg['y_below_face_bottom']), 0)
    y1 = min(int(face_bottom + cfg['y_above_face_bottom']), H)
    x0 = max(face.left - int(cfg['x_pad']), 0)
    x1 = min(face.left + face.size[0] + int(cfg['x_pad']), W)

    def alpha_of(p):
        a = np.zeros((H, W), np.float32)
        ax0, ay0 = max(p.left, 0), max(p.top, 0)
        ax1, ay1 = min(p.left + p.size[0], W), min(p.top + p.size[1], H)
        if ax1 > ax0 and ay1 > ay0:
            a[ay0:ay1, ax0:ax1] = p.img[ay0 - p.top:ay1 - p.top, ax0 - p.left:ax1 - p.left, 3] / 255.0
        return a

    face_a = alpha_of(face)
    zone = np.zeros((H, W), bool)
    zone[y0:y1, x0:x1] = True
    # Skin keeps its colour ratios in shadow: the neck under the chin is much darker than the cheek
    # but still skin, so the test is on chromaticity, not on absolute RGB.
    ref = np.median(orig[zone & (face_a > 0.85)][:, :3], axis=0).astype(np.float32) \
        if (zone & (face_a > 0.85)).sum() > 50 else np.array([232, 198, 183], np.float32)
    rgb = orig[..., :3]
    norm = rgb / np.maximum(rgb.mean(axis=2, keepdims=True), 1e-3)
    ref_norm = ref / max(float(ref.mean()), 1e-3)
    chroma = np.abs(norm - ref_norm).mean(axis=2)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    skin_like = (r > g + 6) & (g > b) & (chroma < float(cfg.get('skin_chroma_thr', 0.10))) & \
        (rgb.mean(axis=2) > float(cfg.get('skin_min_lum', 50.0)))

    top_a = alpha_of(top)
    flat = util.composite(stack, (W, H))
    colour_off = np.abs(flat[..., :3] - orig[..., :3]).mean(axis=2)
    band = zone & (orig[..., 3] > 127) & skin_like & (colour_off > float(cfg['model_diff_thr']))
    stats = dict(zone=[x0, y0, x1, y1], skin_rgb=[round(float(v), 1) for v in ref],
                 band_pixels=int(band.sum()), band_bbox=None,
                 before_mean_diff=None, after_mean_diff=None)
    if band.sum() == 0:
        return stack, stats
    stats['band_bbox'] = [int(v) for v in cv2.boundingRect(band.astype(np.uint8))]
    stats['before_mean_diff'] = round(float(colour_off[band].mean()), 2)

    # Put the artwork's skin back into the part that is actually on top there (the body layer covers
    # the chest skin, the model's collar covered it instead). Parts outside the whitelist - hair
    # falling over the neck - are left alone: a skin pixel under a hair lock is the lock's business.
    owner = np.full((H, W), -1, np.int32)
    for i, p in enumerate(stack):
        a = alpha_of(p)
        owner[a > 0.5] = i
    whitelist = set(cfg.get('top_layers', [top.name, neck.name, 'neckwear', 'face']))
    feather = float(cfg['feather_px'])
    painted, skipped = [], 0
    for i, p in enumerate(stack):
        if p.name not in whitelist:
            continue
        sel = band & (owner == i)
        if sel.sum() == 0:
            continue
        stack[i], added = _paint(stack[i], sel, orig, feather)
        painted.append(dict(layer=p.name, pixels=int(sel.sum()), added_pixels=added))
    outside = band & ~np.isin(owner, [i for i, p in enumerate(stack) if p.name in whitelist])
    skipped = int(outside.sum())
    flat2 = util.composite(stack, (W, H))
    after = np.abs(flat2[..., :3] - orig[..., :3]).mean(axis=2)
    stats['after_mean_diff'] = round(float(after[band].mean()), 2)
    stats['painted'] = painted
    stats['skipped_pixels_top_layer_not_whitelisted'] = skipped
    log(f'repair: chin/collar band {stats["band_pixels"]}px, colour diff '
        f'{stats["before_mean_diff"]} -> {stats["after_mean_diff"]}')
    return stack, stats
    stats['band_bbox'] = [int(v) for v in cv2.boundingRect(band.astype(np.uint8))]
    stats['before_mean_diff'] = round(float(colour_off[band].mean()), 2)
    feather = float(cfg['feather_px'])
    # paint into the highest layer that already covers each pixel, so the repaired skin is what shows;
    # where only the collar covers it, the skin goes into the neck and the collar's alpha is pulled away
    done = np.zeros((H, W), bool)
    painted = []
    for d in donors:
        a = alpha_of(d)
        sel = band & (a > 0.5) & (~done)
        if sel.sum() == 0:
            continue
        i = next(k for k, p in enumerate(stack) if p.name == d.name)
        stack[i], added = _paint(stack[i], sel, orig, feather)
        painted.append(dict(layer=d.name, pixels=int(sel.sum()), added_pixels=added))
        done |= sel
    rest = band & (~done)
    if rest.any():
        i = next(k for k, p in enumerate(stack) if p.name == neck.name)
        stack[i], added = _paint(stack[i], rest, orig, feather)
        painted.append(dict(layer=neck.name, pixels=int(rest.sum()), added_pixels=added, via='rest'))
    # pull the collar's alpha back so the repaired skin is what shows there
    soft = cv2.GaussianBlur(band.astype(np.float32), (0, 0), feather)
    halo = band | (cv2.dilate(band.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0)
    soft = np.maximum(soft, (halo & band).astype(np.float32) * 0.9)
    idx = next(k for k, q in enumerate(stack) if q.name == top.name)
    p = stack[idx]
    img = p.img.copy()
    y_lo, x_lo = p.top, p.left
    ys, xs = np.where(soft[y_lo:y_lo + p.size[1], x_lo:x_lo + p.size[0]] > 0.02)
    if len(ys):
        sy = slice(ys.min(), ys.max() + 1)
        sx = slice(xs.min(), xs.max() + 1)
        m = soft[y_lo + sy.start:y_lo + sy.stop, x_lo + sx.start:x_lo + sx.stop]
        img[sy, sx, 3] = img[sy, sx, 3] * (1 - m)
    stack[idx] = util.Part(top.name, img, p.left, p.top)
    flat2 = util.composite(stack, (W, H))
    after = np.abs(flat2[..., :3] - orig[..., :3]).mean(axis=2)
    stats['after_mean_diff'] = round(float(after[band].mean()), 2)
    stats['painted'] = painted
    log(f'repair: chin/collar band {stats["band_pixels"]}px, colour diff '
        f'{stats["before_mean_diff"]} -> {stats["after_mean_diff"]}')
    return stack, stats


# --------------------------------------------------------------- round 2 repairs

def _part_index(stack, name):
    for i, p in enumerate(stack):
        if p.name == name:
            return i
    return None


def _full_alpha(part, shape):
    out = np.zeros(shape[:2], np.float32)
    h, w = part.img.shape[:2]
    x0, y0 = max(part.left, 0), max(part.top, 0)
    x1, y1 = min(part.left + w, shape[1]), min(part.top + h, shape[0])
    if x1 > x0 and y1 > y0:
        out[y0:y1, x0:x1] = part.img[y0 - part.top:y1 - part.top,
                                     x0 - part.left:x1 - part.left, 3] / 255.0
    return out


def erase_face_eyes(stack, openings, cfg, log=print):
    """Paint the artwork's own lid/lash strokes out of the face layer under the rebuilt eyes.

    The eye layers are drawn from the same artwork but the face keeps a copy of the drawn eye:
    with the eyelid rebuilt as an aperture, that copy shows as the eyeball's outline and as a
    black line across the eye whenever the gaze moves. The aperture plus `ring_px` is inpainted
    from the face's own skin, so the sclera sits on skin, not on a second eye.
    """
    if not cfg.get('enabled', False):
        return stack, dict(enabled=False)
    mask = np.zeros(openings[0].shape, np.float32)
    for opening in openings:
        mask = np.maximum(mask, opening)
    ring = int(cfg.get('ring_px', 3)) + int(cfg.get('dilate_px', 0))
    if ring > 0:
        mask = cv2.dilate((mask > 0.02).astype(np.uint8),
                          np.ones((2 * ring + 1, 2 * ring + 1), np.uint8)).astype(np.float32)
    stats = dict(enabled=True, ring_px=ring, mask_pixels=int((mask > 0.5).sum()), layers={})
    for name in cfg.get('layers') or ['face']:
        i = _part_index(stack, name)
        if i is None:
            stats['layers'][name] = dict(skipped='layer missing')
            continue
        p = stack[i]
        img = p.img.copy()
        y0, x0 = p.top, p.left
        h, w = img.shape[:2]
        sub = mask[y0:y0 + h, x0:x0 + w]
        if not sub.any():
            stats['layers'][name] = dict(painted_pixels=0)
            continue
        hard = (sub > 0.5).astype(np.uint8)
        rgb8 = np.clip(img[..., :3], 0, 255).astype(np.uint8)
        filled = cv2.inpaint(np.ascontiguousarray(rgb8), hard,
                             float(cfg.get('telea_radius', 6.0)), cv2.INPAINT_TELEA)
        wgt = cv2.GaussianBlur(sub, (0, 0), 1.2)
        wgt = np.maximum(wgt, hard.astype(np.float32))[..., None]
        img[..., :3] = img[..., :3] * (1 - wgt) + filled.astype(np.float32) * wgt
        stack[i] = util.Part(p.name, img, p.left, p.top)
        stats['layers'][name] = dict(painted_pixels=int(hard.sum()))
    log(f'repair: face eye strokes erased over {stats["mask_pixels"]}px '
        f'(opening + {ring}px ring)')
    return stack, stats


def rebuild_neck(stack, orig, cfg, face_name='face', collar_name='topwear', log=print):
    """Replace the sliver See-through calls a neck with a solid one built from the artwork.

    See-through's neck mask keeps ~4% of the layer visible: between chin and collar the model has
    nothing, so a head turn shows the background through the neck. The rebuilt layer is solid
    skin - colour from the artwork's own pixels where it has them, the row's median skin colour
    where it is hidden - with the artwork's neck width per row, running from inside the collar up
    past the chin (hidden under the face, which is above it in the stack).
    """
    if not cfg.get('enabled', False):
        return stack, dict(enabled=False)
    H, W = orig.shape[:2]
    face_i = _part_index(stack, face_name)
    collar_i = _part_index(stack, collar_name)
    neck_i = _part_index(stack, 'neck')
    if face_i is None or collar_i is None:
        return stack, dict(enabled=False, skipped='face or topwear missing')
    face, collar = stack[face_i], stack[collar_i]
    chin_y = face.top + face.size[1]
    collar_top = collar.top
    cx0 = face.left + int(face.size[0] * 0.02)
    cx1 = face.left + int(face.size[0] * 0.98)
    y_lo = max(chin_y - 30, 0)
    y_hi = min(chin_y + int(cfg.get('below_chin_px', 160)), H)
    if y_hi <= y_lo:
        return stack, dict(enabled=False, skipped='empty chin/collar band')
    rgb = orig[..., :3]
    alpha = orig[..., 3] / 255.0
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    chroma = (mx - mn) / np.maximum(mx, 1.0)
    warm = (rgb[..., 0] >= rgb[..., 1]) & (rgb[..., 1] >= rgb[..., 2])
    # The knit collar is warm white (227,213,201, R-G = 14) and the neck is warm skin
    # (238,192,175, R-G = 46); chroma and brightness alone classify the collar as skin, which is how
    # the sweater used to be copied into this layer.
    red_green = rgb[..., 0].astype(np.float32) - rgb[..., 1].astype(np.float32)
    skin = ((alpha > 0.9) & warm & (red_green > float(cfg.get('skin_red_green_min', 18.0)))
            & (mx > 60) & (mx < 245))
    rows = {}
    for y in range(y_lo, y_hi):
        xs = np.where(skin[y, cx0:cx1])[0]
        if not len(xs):
            continue
        xs = xs + cx0
        xs_set = set(xs.tolist())
        # the run around this row's own centre: an arm or another part's skin at the edge of the
        # window must not widen the neck
        centre = int(np.median(xs))
        left = centre
        while left - 1 in xs_set:
            left -= 1
        right = centre
        while right + 1 in xs_set:
            right += 1
        if right - left + 1 < 4:
            continue
        run = xs[(xs >= left) & (xs <= right)]
        rows[y] = (int(left), int(right), np.median(rgb[y, run], axis=0))
    if len(rows) < int(cfg.get('min_visible_rows', 12)):
        return stack, dict(enabled=False,
                           skipped=f'only {len(rows)} skin rows between chin and collar')
    ys = np.array(sorted(rows), np.float32)
    left = np.array([rows[int(y)][0] for y in ys], np.float32)
    right = np.array([rows[int(y)][1] for y in ys], np.float32)
    colours = np.stack([rows[int(y)][2] for y in ys])
    top_y = max(chin_y - int(cfg.get('above_chin_px', 130)), 0)
    bot_y = min(int(ys.max()) + int(cfg.get('below_last_row_px', 10)),
                collar_top + int(cfg.get('below_collar_px', 60)), H)
    height = bot_y - top_y
    yy = np.arange(top_y, bot_y, dtype=np.float32)
    left_row = np.interp(yy, ys, left)
    right_row = np.interp(yy, ys, right)
    colour_row = np.stack([np.interp(yy, ys, colours[:, c]) for c in range(3)], axis=1)
    margin = float(cfg.get('row_margin_px', 4))
    # Below the chin only the artwork's own neck width may show - anything wider would paint skin
    # over hair or coat.
    solid = np.zeros((height, W), np.float32)
    # below the chin: every pixel the artwork draws as skin in the neck window, closed into a
    # solid shape - a head tilt then uncovers skin, and never the background through a gap
    under = np.zeros((height, W), bool)
    skin_win = skin[top_y:bot_y, :]
    under[:] = skin_win
    under[:max(int(chin_y - top_y), 0), :] = False
    under[:, :max(int(face.left), 0)] = False
    under[:, int(face.left + face.size[0]):] = False
    under = cv2.morphologyEx(under.astype(np.uint8), cv2.MORPH_CLOSE,
                             np.ones((int(cfg.get('close_px', 5)),) * 2, np.uint8))
    grow = int(cfg.get('under_dilate_px', 2))
    if grow > 0:
        under = cv2.dilate(under, np.ones((2 * grow + 1,) * 2, np.uint8))
    solid = np.maximum(solid, under.astype(np.float32))
    # Above the chin the neck stays behind the face. Its width there is the width the artwork draws
    # the neck with in its topmost visible row: wider than that (the chin's width) painted flat skin
    # past the neck onto the collar, which showed up as a pale block whenever the head moved.
    top_y0 = int(left_row[0] - margin)
    top_y1 = int(right_row[0] + margin) + 1
    solid[:max(int(chin_y - top_y), 0), max(top_y0, 0):min(top_y1, W)] = 1.0
    sigma = float(cfg.get('feather_px', 1.5))
    if sigma > 0:
        solid = cv2.GaussianBlur(solid, (0, 0), sigma)
    solid = np.clip(solid, 0, 1)
    img = np.zeros((height, W, 4), np.float32)
    img[..., :3] = colour_row[:, None, :]
    img[..., 3] = solid * 255.0
    # Below the chin the layer takes the artwork verbatim inside the neck's own columns, so the
    # visible strip keeps its drawn shading instead of a flat row colour. Above the chin the
    # artwork is the chin itself, and copying it here is what put a second face in the neck layer.
    art = orig[top_y:bot_y, :, :]
    win = np.zeros((height, W), bool)
    for i, y in enumerate(range(top_y, bot_y)):
        if y >= chin_y:
            win[i, max(int(left_row[i] - margin), 0):min(int(right_row[i] + margin) + 1, W)] = True
    take = win & (art[..., 3] > 0.9)
    img[..., :3][take] = art[..., :3][take]
    stats_pixels_from_art = int(take.sum())
    ys_nz, xs_nz = np.where(img[..., 3] > 2)
    new = util.Part('neck', img[ys_nz.min():ys_nz.max() + 1, xs_nz.min():xs_nz.max() + 1],
                    int(xs_nz.min()), int(top_y + ys_nz.min()))
    old_alpha = (_full_alpha(stack[neck_i], orig.shape) > 0.5) if neck_i is not None else None
    if neck_i is not None:
        stack[neck_i] = new
    else:
        stack.insert(max(face_i - 1, 0), new)
    stats = dict(enabled=True,
                 skin_rows=len(rows),
                 window=[int(cx0), int(y_lo), int(cx1), int(y_hi)],
                 row_span_x=[int(left.min()), int(right.max())],
                 rows=[int(top_y), int(bot_y)],
                 extension_above_chin_px=int(chin_y - top_y),
                 extension_below_chin_px=int(bot_y - chin_y),
                 into_collar_px=int(bot_y - collar_top),
                 layer_bbox=[new.left, new.top, new.size[0], new.size[1]],
                 layer_solid_pixels=int((new.img[..., 3] > 127).sum()),
                 colour_median=[round(float(v), 1) for v in np.median(colours, axis=0)],
                 pixels_from_artwork=stats_pixels_from_art,
                 before_solid_pixels=int(old_alpha.sum()) if old_alpha is not None else 0)
    log(f'repair: neck rebuilt solid {stats["layer_solid_pixels"]}px over '
        f'{stats["rows"][1] - stats["rows"][0]} rows, width {stats["row_span_x"]}, '
        f'above chin {stats["extension_above_chin_px"]}px, below {stats["extension_below_chin_px"]}px '
        f'(was {stats["before_solid_pixels"]}px)')
    return stack, stats


def erase_residue(stack, cfg, log=print):
    """Erase a duplicated accessory (the earrings) from the layers that also carry it.

    See-through leaves the earrings painted into `face`, `ears` and the hair as well as in their
    own `earwear` layer. Two earrings then show, and a head turn separates them. Where a target
    layer is opaque, inside the reference layer's box and close to its colour, the target's
    pixels are inpainted from their own surroundings; the reference layer keeps the only copy.
    """
    if not cfg.get('enabled', False):
        return stack, dict(enabled=False)
    refs = []
    for name in cfg.get('references') or []:
        i = _part_index(stack, name)
        if i is None:
            continue
        p = stack[i]
        alpha_local = p.img[..., 3] / 255.0
        sel = alpha_local > 0.5
        if not sel.any():
            continue
        refs.append(dict(name=name, part=p,
                         rgb=np.median(p.img[sel][:, :3], axis=0),
                         box=[p.left, p.top, p.left + p.size[0], p.top + p.size[1]]))
    stats = dict(enabled=True, references=[dict(name=r['name'],
                                                colour=[round(float(v), 1) for v in r['rgb']],
                                                box=r['box']) for r in refs], layers={})
    if not refs:
        stats['skipped'] = 'no reference layer with pixels'
        return stack, stats
    tol = float(cfg.get('colour_tol', 34.0))
    pad = int(cfg.get('dilate_px', 4))
    min_area = int(cfg.get('min_blob_area', 3))
    for name in cfg.get('targets') or []:
        i = _part_index(stack, name)
        if i is None:
            continue
        p = stack[i]
        img = p.img.copy()
        h, w = img.shape[:2]
        sel = np.zeros((h, w), bool)
        for ref in refs:
            bx0, by0, bx1, by1 = ref['box']
            dx0, dy0 = max(bx0 - pad, p.left), max(by0 - pad, p.top)
            dx1, dy1 = min(bx1 + pad, p.left + w), min(by1 + pad, p.top + h)
            if dx1 <= dx0 or dy1 <= dy0:
                continue
            sub = img[dy0 - p.top:dy1 - p.top, dx0 - p.left:dx1 - p.left]
            d = np.abs(sub[..., :3] - ref['rgb']).mean(axis=2)
            cand = (d < tol) & (sub[..., 3] > 128)
            sel[dy0 - p.top:dy1 - p.top, dx0 - p.left:dx1 - p.left] |= cand
        if not sel.any():
            stats['layers'][name] = dict(residue_pixels=0)
            continue
        n, lab, st, _c = cv2.connectedComponentsWithStats(sel.astype(np.uint8), 8)
        keep = np.zeros_like(sel)
        for k in range(1, n):
            if int(st[k, cv2.CC_STAT_AREA]) >= min_area:
                keep |= (lab == k)
        if not keep.any():
            stats['layers'][name] = dict(residue_pixels=0,
                                         small_blobs_ignored=int(sel.sum()))
            continue
        hard = keep.astype(np.uint8)
        rgb8 = np.clip(img[..., :3], 0, 255).astype(np.uint8)
        filled = cv2.inpaint(np.ascontiguousarray(rgb8), hard,
                             float(cfg.get('telea_radius', 6.0)), cv2.INPAINT_TELEA)
        wgt = cv2.GaussianBlur(hard.astype(np.float32), (0, 0), 1.0)
        wgt = np.maximum(wgt, hard.astype(np.float32))[..., None]
        img[..., :3] = img[..., :3] * (1 - wgt) + filled.astype(np.float32) * wgt
        stack[i] = util.Part(p.name, img, p.left, p.top)
        stats['layers'][name] = dict(residue_pixels=int(hard.sum()))
    # the accessory's own footprint: erase every pixel under it from the other layers, so only
    # the accessory layer can ever draw the earrings - colour matching alone misses the copy
    # that is painted with a slightly different shade
    fp = cfg.get('footprint') or {}
    if fp.get('enabled', False):
        cw = max(p.left + p.size[0] for p in stack)
        chh = max(p.top + p.size[1] for p in stack)
        mask = np.zeros((chh, cw), bool)
        for ref in refs:
            part = ref['part']
            m = part.img[..., 3] > 128
            mask[part.top:part.top + part.size[1], part.left:part.left + part.size[0]] |= m
        grow = int(fp.get('dilate_px', 3))
        if grow > 0:
            mask = cv2.dilate(mask.astype(np.uint8), np.ones((2 * grow + 1,) * 2, np.uint8)) > 0
        ref_names = {r['name'] for r in refs}
        stats['footprint'] = dict(pixels=int(mask.sum()), dilate_px=grow, layers={})
        for name in cfg.get('targets') or []:
            if name in ref_names:
                continue
            i = _part_index(stack, name)
            if i is None:
                continue
            p = stack[i]
            x0, y0 = max(p.left, 0), max(p.top, 0)
            x1, y1 = min(p.left + p.size[0], mask.shape[1]), min(p.top + p.size[1], mask.shape[0])
            if x1 <= x0 or y1 <= y0:
                stats['footprint']['layers'][name] = 0
                continue
            sub = p.img[y0 - p.top:y1 - p.top, x0 - p.left:x1 - p.left]
            sel = mask[y0:y1, x0:x1] & (sub[..., 3] > 0)
            if not sel.any():
                stats['footprint']['layers'][name] = 0
                continue
            img = p.img.copy()
            hard = sel.astype(np.uint8)
            rgb8 = np.clip(sub[..., :3], 0, 255).astype(np.uint8)
            filled = cv2.inpaint(np.ascontiguousarray(rgb8), hard,
                                 float(cfg.get('telea_radius', 6.0)), cv2.INPAINT_TELEA)
            wgt = cv2.GaussianBlur(hard.astype(np.float32), (0, 0), 1.0)
            wgt = np.maximum(wgt, hard.astype(np.float32))[..., None]
            region = img[y0 - p.top:y1 - p.top, x0 - p.left:x1 - p.left]
            region[..., :3] = region[..., :3] * (1 - wgt) + filled.astype(np.float32) * wgt
            stack[i] = util.Part(p.name, img, p.left, p.top)
            stats['footprint']['layers'][name] = int(hard.sum())
        log(f'repair: erased {int(hard.sum())}px of duplicated accessory from `{name}`')
    return stack, stats


def fix_colour_specks(stack, orig, cfg, log=print):
    """Take the artwork's own colour where the composite shows a small wrong-coloured patch.

    See-through's inpainted interiors keep the model's colour wherever the artwork differs by more
    than the swap tolerance, so a mis-inpainted patch (the coat's right edge came out pale blue)
    survives as a dot of the wrong colour. Small blobs that the artwork covers opaquely are
    repainted with the artwork's pixels in the layers that cover them; large regions are left to
    the seam repaint above.
    """
    if not cfg.get('enabled', False):
        return stack, dict(enabled=False)
    H, W = orig.shape[:2]
    oa = orig[..., 3] / 255.0
    gate_orig = float(cfg.get('orig_alpha_gate', 0.85))
    thr = float(cfg.get('colour_thr', 55.0))
    max_area = int(cfg.get('max_area_px', 400))
    exclude = set(cfg.get('exclude_layers') or [])
    stats = dict(enabled=True, colour_thr=thr, max_area_px=max_area, passes=[])
    for _pass in range(int(cfg.get('max_passes', 2))):
        flat = util.composite(stack, (W, H))
        fa = flat[..., 3] / 255.0
        diff = np.abs(flat[..., :3] - orig[..., :3]).mean(axis=2)
        bad = (diff > thr) & (fa > 0.5) & (oa > gate_orig)
        if not bad.any():
            stats['passes'].append(dict(pixels=0))
            break
        n, lab, st, _c = cv2.connectedComponentsWithStats(bad.astype(np.uint8), 8)
        fixed = 0
        touched = {}
        for k in range(1, n):
            area = int(st[k, cv2.CC_STAT_AREA])
            if area > max_area:
                continue
            blob = (lab == k)
            for i, p in enumerate(stack):
                if p.name in exclude:
                    continue
                h, w = p.img.shape[:2]
                y0, x0 = max(p.top, 0), max(p.left, 0)
                y1, x1 = min(p.top + h, H), min(p.left + w, W)
                if x1 <= x0 or y1 <= y0:
                    continue
                sub = p.img[y0 - p.top:y1 - p.top, x0 - p.left:x1 - p.left]
                bsel = blob[y0:y1, x0:x1] & (sub[..., 3] > 128)
                if not bsel.any():
                    continue
                sub[..., :3][bsel] = orig[y0:y1, x0:x1, :3][bsel]
                touched[p.name] = touched.get(p.name, 0) + int(bsel.sum())
            fixed += area
        stats['passes'].append(dict(pixels=int(bad.sum()), repaired_blob_pixels=fixed,
                                    layers=touched))
        if not fixed:
            break
    flat = util.composite(stack, (W, H))
    diff = np.abs(flat[..., :3] - orig[..., :3]).mean(axis=2)
    fa = flat[..., 3] / 255.0
    stats['remaining_offending_pixels'] = int(((diff > thr) & (fa > 0.5) & (oa > gate_orig)).sum())
    log(f'repair: colour specks -> {stats["passes"]}, remaining {stats["remaining_offending_pixels"]}px')
    return stack, stats
