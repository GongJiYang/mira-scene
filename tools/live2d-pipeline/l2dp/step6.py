"""Step 6 - assemble the native-resolution PSD that psd2live will rig."""
import os

import cv2
import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.constants import BlendMode

from . import overrides, repair, util, variants

# Part.blend -> the PSD blend mode psd2live reads back (psd2live maps 'mul ' to Multiply)
_BLEND_MODES = {'normal': BlendMode.NORMAL, 'multiply': BlendMode.MULTIPLY}


def _insert_after_layer(out, anchor, names, avail):
    """Insert `names` right after `anchor` (used for the drawn variant layers)."""
    if anchor not in out:
        return out
    i = out.index(anchor)
    add = [n for n in names if n in avail and n not in out]
    return out[:i + 1] + add + out[i + 1:]


def stack_order(cfg, base_names, residual_names, available=()):
    """Bottom -> top layer order. See-through's own order, with the eyes replaced per side."""
    c = cfg['step6_compose']
    renames = c.get('renames') or {}
    avail = set(available)
    out = []
    inserted_residual = False
    for name in base_names:
        n = renames.get(name, name)
        if n in avail and n not in out:
            out.append(n)
        if name == c['insert_after'] and not inserted_residual:
            out.extend(r for r in residual_names if r not in out)
            inserted_residual = True
    if not inserted_residual:
        out.extend(n for n in residual_names if n not in out)

    # eye stack replaces the model's three eye layers
    brow = c['brow_layer']
    eye_block = [f'{k}{s}' for k in c['eye_order']
                 for s in (c['split_suffix_left'], c['split_suffix_right'])]
    eye_block = [n for n in eye_block if n in avail]

    idx = out.index(brow) if brow in out else len(out)
    out = out[:idx] + eye_block + out[idx:]

    for anchor, names in (c.get('insert_after_layer') or {}).items():
        out = _insert_after_layer(out, renames.get(anchor, anchor), names, avail)

    top = c['top_layer']
    if top in out:
        out.remove(top)
        out.append(top)
    return out


def run(cfg, out_root, log=print):
    c = cfg['step6_compose']
    out = os.path.join(out_root, 'step6')
    os.makedirs(out, exist_ok=True)

    orig = util.load_rgba(cfg['input']['original_png'])
    H, W = orig.shape[:2]

    base_parts = util.load_parts(os.path.join(out_root, 'step4', 'layers'))
    parts = {p.name: p for p in base_parts}
    res_dir = os.path.join(out_root, 'step4', 'residual_layers')
    residual = util.load_parts(res_dir) if os.path.exists(os.path.join(res_dir, 'index.json')) else []
    for p in residual:
        parts[p.name] = p
    if not os.path.exists(os.path.join(out_root, 'step5', 'layers', 'index.json')):
        raise RuntimeError('step5 eye layers missing')
    eye_parts = util.load_parts(os.path.join(out_root, 'step5', 'layers'))
    for p in eye_parts:
        parts[p.name] = p

    # ---- hidden-area reference-pack overrides (docs/live2d-ref-pack.md) ------
    # the mask needs the stack order: an override may be limited to the pixels the layers above
    # already cover (the parts that are hidden in the artwork)
    pre_base = [p.name for p in base_parts if p.name not in set(c.get('drop_base_layers') or [])]
    pre_order = stack_order(cfg, pre_base, [p.name for p in residual], parts.keys())
    parts, override_metrics = overrides.apply(cfg, parts, orig, out_root,
                                              order=pre_order, log=log)

    # ---- drawn variants: closed eyes, open mouth ----------------------------
    s5 = util.read_json(os.path.join(out_root, 'step5', 'metrics.json'))
    variant_parts, variant_metrics = variants.build(cfg, orig, parts, s5.get('eyes') or {})
    for p in variant_parts:
        parts[p.name] = p
    if variant_parts:
        util.save_parts(variant_parts, os.path.join(out, 'variant_layers'))
    # the mouth mask is the closed state's alpha: every state is cut to it, so compare and the
    # report can measure the ring outside it without re-deriving it
    mouth_cfg = (cfg.get('variant_layers') or {}).get('mouth') or {}
    close_part = parts.get(mouth_cfg.get('close_name', 'mouth close'))
    if close_part is not None:
        mask_full = np.zeros((H, W), np.float32)
        mh, mw = close_part.img.shape[:2]
        mask_full[close_part.top:close_part.top + mh,
                  close_part.left:close_part.left + mw] = close_part.img[..., 3] / 255.0
        util.save_rgba(np.concatenate([np.repeat((mask_full * 255.0)[..., None], 3, axis=2),
                                       np.full((H, W, 1), 255.0, np.float32)], axis=2),
                       os.path.join(out, 'mouth_mask.png'))

    base_order = [p.name for p in base_parts if p.name not in set(c.get('drop_base_layers') or [])]
    residual_names = [p.name for p in residual]
    order = stack_order(cfg, base_order, residual_names, parts.keys())
    unknown = [n for n in order if n not in parts]
    if unknown:
        raise RuntimeError(f'layer order names missing from parts: {unknown}')

    stack = [parts[n] for n in order]

    # ---- seam repair: lost pixels, then the chin/collar colour step ---------
    rc = c['repair']
    stack, hole_metrics = repair.fill_holes(stack, orig, rc['holes'], log=log)
    neck_metrics = dict(enabled=False)
    if rc.get('neck'):
        stack, neck_metrics = repair.rebuild_neck(stack, orig, rc['neck'], log=log)
    stack, band_metrics = repair.repair_chin_collar(stack, orig, rc['band'], log=log)
    residue_metrics = dict(enabled=False)
    if rc.get('residue'):
        stack, residue_metrics = repair.erase_residue(stack, rc['residue'], log=log)
    eye_metrics = dict(enabled=False)
    if rc.get('face_eyes'):
        openings = []
        for side in ('l', 'r'):
            p = os.path.join(out_root, 'step5', f'opening-{side}.png')
            if os.path.exists(p):
                openings.append(util.load_rgba(p)[..., 3] / 255.0)
        if openings:
            stack, eye_metrics = repair.erase_face_eyes(stack, openings, rc['face_eyes'], log=log)
        else:
            eye_metrics = dict(enabled=False, skipped='no step5 opening masks')
    speck_metrics = dict(enabled=False)
    if rc.get('specks'):
        stack, speck_metrics = repair.fix_colour_specks(stack, orig, rc['specks'], log=log)
    # At rest the drawn variants are invisible (psd2live drives their opacity from ParamEye*Open /
    # ParamMouthOpenY), so the self-check and the visibility table use the rest-pose stack.
    rest_hidden = set(c.get('rest_hidden') or [])
    rest_stack = [p for p in stack if p.name not in rest_hidden]
    flat = util.composite(rest_stack, (W, H))
    diff, gate = util.gated_diff(orig, flat, c['compare_alpha_gate'])

    # how much of each layer survives the layers above it: catches layers that are dead weight
    # (placed under an opaque part) without being obvious in the flattened image
    visibility = {}
    for i, p in enumerate(rest_stack):
        h, w = p.img.shape[:2]
        x0, y0 = max(p.left, 0), max(p.top, 0)
        x1, y1 = min(p.left + w, W), min(p.top + h, H)
        if x1 <= x0 or y1 <= y0:
            visibility[p.name] = dict(alpha_pixels=0, visible_pixels=0, visible_pct=0.0)
            continue
        sub = p.img[y0 - p.top:y1 - p.top, x0 - p.left:x1 - p.left]
        alpha = sub[..., 3] / 255.0
        above = np.zeros_like(alpha)
        for q in rest_stack[i + 1:]:
            qh, qw = q.img.shape[:2]
            ax0, ay0 = max(q.left, x0), max(q.top, y0)
            ax1, ay1 = min(q.left + qw, x1), min(q.top + qh, y1)
            if ax1 <= ax0 or ay1 <= ay0:
                continue
            qa = q.img[ay0 - q.top:ay1 - q.top, ax0 - q.left:ax1 - q.left, 3] / 255.0
            sl = above[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0]
            above[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = qa + sl * (1 - qa)
        solid = alpha > 0.5
        vis = alpha * (1 - above)
        visibility[p.name] = dict(
            alpha_pixels=int(solid.sum()),
            visible_pixels=int((vis > 0.5).sum()),
            visible_pct=round(100.0 * float((vis > 0.5).sum()) / max(int(solid.sum()), 1), 1))

    # the repaired stack, for the comparison step and the figures: the PSD is the deliverable,
    # these are the same pixels one layer at a time
    util.save_parts(stack, os.path.join(out, 'layers'))

    # ---- write the PSD -------------------------------------------------------
    psd_path = os.path.join(out, 'native.psd')
    psd = PSDImage.new(mode=c['psd_mode'], size=(W, H), depth=8)
    for p in stack:
        psd.create_pixel_layer(Image.fromarray(
            np.ascontiguousarray(np.clip(p.img, 0, 255).astype(np.uint8)), 'RGBA'),
            name=p.name, top=p.top, left=p.left, opacity=255,
            blend_mode=_BLEND_MODES.get(getattr(p, 'blend', 'normal'), BlendMode.NORMAL))
    psd.save(psd_path)

    # ---- verify by reading the PSD back --------------------------------------
    back = PSDImage.open(psd_path)
    reread = []
    for layer in back.descendants():
        if layer.kind == 'pixel':
            bm = 'multiply' if layer.blend_mode == BlendMode.MULTIPLY else 'normal'
            reread.append(util.Part(layer.name, util.layer_rgba(layer),
                                    layer.bbox[0], layer.bbox[1], blend=bm))
    flat2 = util.composite([p for p in reread if p.name not in rest_hidden], (W, H))
    diff_read, gate_read = util.gated_diff(orig, flat2, c['compare_alpha_gate'])

    util.save_rgba(flat, os.path.join(out, 'flattened.png'))
    # the hole figures are quoted from the file the comparison step reads, so 8-bit rounding
    # cannot make the two disagree by a pixel
    rounded = util.load_rgba(os.path.join(out, 'flattened.png'))
    from_file = repair.hole_report(orig, rounded, stack, [p.name for p in stack])
    from_file.pop('_hole', None)
    from_file.pop('_enclosed', None)
    hole_metrics['after_saved_png_file'] = from_file
    k = 0.5
    half = lambda a: cv2.resize(a, (int(W * k), int(H * k)), interpolation=cv2.INTER_AREA)
    util.montage([half(util.on_checker(orig)), half(util.on_checker(flat)),
                  half(util.overlay50(orig, flat)),
                  half(util.diff_heatmap(orig, flat, gate))],
                 cols=4, cell=(int(W * k), int(H * k)),
                 labels=['original', f'flattened native.psd ({len(reread)} layers)',
                         'overlay 50%', 'diff heatmap x3']).save(
        os.path.join(out, 'check_step6_composite.png'))

    # seam figure: holes and the chin/collar band, before and after the repair
    seamed = cv2.resize(util.on_checker(flat), (int(W * k), int(H * k)), interpolation=cv2.INTER_AREA)
    band = band_metrics.get('band_bbox')
    vis = util.on_checker(orig).copy()
    if band:
        x0, y0, bw, bh = band
        cv2.rectangle(vis, (int(x0 * k), int(y0 * k)),
                      (int((x0 + bw) * k), int((y0 + bh) * k)), (60, 255, 120), 1)
    hole_tiles, hole_labels = [], []
    boxes = (band_metrics.get('zone') or [330, 520, 700, 700])
    zx0, zy0 = int(boxes[0]), int(boxes[1])
    zx1, zy1 = int(boxes[2]), int(boxes[3])
    zy0, zy1 = max(zy0, 0), min(zy1, H)
    for name, img in (('original', orig), ('flattened', flat)):
        crop = util.on_checker(img[zy0:zy1, zx0:zx1])
        z = 3
        hole_tiles.append(cv2.resize(crop, (crop.shape[1] * z, crop.shape[0] * z),
                                     interpolation=cv2.INTER_NEAREST))
        hole_labels.append(f'{name} (chin/collar zone) x3')
    util.montage(hole_tiles, cols=2, cell=(hole_tiles[0].shape[1], hole_tiles[0].shape[0]),
                 labels=hole_labels).save(os.path.join(out, 'check_step6_seam.png'))

    step3 = util.read_json(os.path.join(out_root, 'step3', 'metrics.json'))
    ref_diff = step3['formula_result']['mean_abs_color_diff']

    metrics = dict(
        step=6,
        canvas=[W, H],
        psd_mode=c['psd_mode'],
        layer_order_bottom_to_top=order,
        layer_count=len(order),
        layers=[dict(name=p.name, left=p.left, top=p.top, width=p.size[0], height=p.size[1])
                for p in stack],
        psd=psd_path,
        psd_bytes=os.path.getsize(psd_path),
        flat_vs_original=dict(mean_abs_color_diff=diff, gated_pixels=int(gate.sum())),
        layer_visibility=visibility,
        rest_hidden=sorted(rest_hidden),
        re_read_psd_flat_vs_original=dict(mean_abs_color_diff=diff_read, gated_pixels=int(gate_read.sum())),
        step3_reference_diff=ref_diff,
        passes_self_check=bool(diff_read <= ref_diff),
        variants=variant_metrics,
        overrides=override_metrics,
        seam=dict(holes=hole_metrics, chin_collar_band=band_metrics,
                  neck=neck_metrics, residue=residue_metrics, face_eyes=eye_metrics,
                  specks=speck_metrics),
        figures=['check_step6_composite.png', 'check_step6_seam.png'],
        artifacts=['flattened.png', 'native.psd'],
    )
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    log(f'step6: {len(order)} layers -> {psd_path} ({metrics["psd_bytes"] / 1e6:.1f} MB); '
        f'flat diff={diff:.3f} (re-read {diff_read:.3f}) vs step3 {ref_diff:.3f} '
        f'-> {"OK" if diff_read <= ref_diff else "FAIL"}')
    log(f'  holes: {hole_metrics.get("before", {}).get("interior_pixels")} interior -> '
        f'{hole_metrics.get("after_saved_png_file", {}).get("interior_pixels")} '
        f'(in memory {hole_metrics.get("after", {}).get("interior_pixels")}); '
        f'chin/collar diff {band_metrics.get("before_mean_diff")} -> {band_metrics.get("after_mean_diff")}')
    log('  order: ' + ' < '.join(order))
    return metrics
