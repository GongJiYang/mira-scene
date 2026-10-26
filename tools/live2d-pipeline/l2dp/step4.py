"""Step 4 - upscale every part to the original resolution, swap in real artwork pixels where the
part was visible, and recover what See-through dropped (residual check + new layers)."""
import os

import cv2
import numpy as np

from . import util


ALPHA_INTERP = {'lanczos': cv2.INTER_LANCZOS4, 'cubic': cv2.INTER_CUBIC,
                'linear': cv2.INTER_LINEAR, 'area': cv2.INTER_AREA}


def alpha_upscale(src_alpha, size, cfg):
    """Upscaled alpha, smoothed rather than nearest/cubic so the layer edge has no staircase."""
    interp = ALPHA_INTERP[cfg.get('interpolation', 'lanczos')]
    out = cv2.resize(src_alpha, size, interpolation=interp)
    out = np.clip(out, 0, 255)
    sigma = float(cfg.get('gaussian_sigma', 0.0))
    if sigma > 0:
        out = cv2.GaussianBlur(out, (0, 0), sigma)
    return np.clip(out, 0, 255)


def alpha_from_original(alpha_up, orig_alpha, cfg):
    """Where the layer's own edge coincides with the artwork's silhouette, take the artwork's alpha.

    The model is a 768px reconstruction; its edge is only as sharp as that grid. The artwork's own
    alpha is native resolution and already anti-aliased, so wherever the two agree on the edge the
    artwork's value is strictly better. Elsewhere (the model's inpainted interior) nothing changes.
    Returns (alpha 0..1, weight 0..1).
    """
    a_m = alpha_up / 255.0
    a_o = orig_alpha / 255.0
    if not cfg.get('enabled', False):
        return a_m, np.zeros_like(a_m)
    lo, ramp = float(cfg['min_alpha']), float(cfg['ramp'])
    near_edge = np.abs(a_m - a_o) <= float(cfg['coincide_tol'])
    w = util.smoothstep(a_o, lo, lo + ramp) * near_edge.astype(np.float32)
    sigma = float(cfg['feather_px'])
    if sigma > 0:
        w = cv2.GaussianBlur(w, (0, 0), sigma)
    w = np.clip(w, 0, 1)
    # The artwork's *colour* may only be taken on the layer's own edge band: inside the part both
    # alphas are ~1, and there the flat artwork shows whatever is drawn on top of this part.
    band = ((a_m > 0.04) & (a_m < 0.96)).astype(np.uint8)
    band = cv2.dilate(band, np.ones((5, 5), np.uint8)).astype(np.float32)
    return a_m * (1 - w) + a_o * w, w * band


def silhouette_clip(a_m, orig_alpha, cfg):
    """Cap a layer's alpha at the artwork's own alpha.

    See-through's masks can reach past the artwork's outline: `handwear`'s mask covers a wedge
    outside the coat's right edge (bbox [977, 1031, 16, 75] in native pixels), and the colour
    there is inpainted, so compositing it paints a blue speck where the artwork is transparent.
    The artwork's alpha is the ground truth for the silhouette, so no layer may be more opaque
    than it. Returns (alpha 0..1, stats).
    """
    a_o = np.clip(orig_alpha / 255.0, 0, 1)
    # Only the faint fringe is capped: where the artwork is (nearly) transparent a layer must be
    # too - that is the blue speck. Pixels the artwork already covers more than `faint_limit` keep
    # the layer's own alpha, so a real silhouette edge is not touched (its staircase metric, its
    # colour and its holes stay what they were).
    faint = float(cfg.get('faint_limit', 0.35))
    limit = np.where(a_o < faint, a_o, 1.0).astype(np.float32)
    sigma = float(cfg.get('limit_blur_px', 0.0))
    if sigma > 0:
        limit = cv2.GaussianBlur(limit, (0, 0), sigma)
    limit = np.clip(limit, 0, 1)
    over = a_m > limit + 1e-6
    out = np.minimum(a_m, limit)
    return out, dict(
        clipped_pixels=int(over.sum()),
        clipped_opaque_pixels=int((over & (a_m > 0.5)).sum()),
        painted_where_artwork_transparent=int(((a_m > 0.5) & (a_o < 0.2)).sum()),
        removed_where_artwork_transparent=int(((a_m > 0.5) & (a_o < 0.2) & (out <= 0.5)).sum()),
        max_clip=round(float((a_m - limit)[over].max()), 4) if over.any() else 0.0,
    )


def upscale_layer(layer, mapping, orig, tolerance, alpha_gate=0.85, alpha_ramp=0.15,
                  require_original_alpha=True, swap=True, alpha_cfg=None, alpha_orig_cfg=None):
    """Native-resolution Part with original-art pixels swapped in where the model matches."""
    nx1, ny1, nx2, ny2 = mapping.bbox_native(layer.bbox)
    if nx2 <= nx1 or ny2 <= ny1:
        return None, None
    src = util.layer_rgba(layer)
    w, h = nx2 - nx1, ny2 - ny1
    rgb = cv2.resize(src[..., :3], (w, h), interpolation=cv2.INTER_CUBIC)
    alpha_up = alpha_upscale(src[..., 3], (w, h), alpha_cfg or {'interpolation': 'cubic'})

    patch = orig[ny1:ny2, nx1:nx2]
    a01, from_orig_w = alpha_from_original(alpha_up, patch[..., 3], alpha_orig_cfg or {})
    clip_cfg = (alpha_cfg or {}).get('silhouette_clip') or {}
    clip_info = None
    if clip_cfg.get('enabled', False):
        allowed = clip_cfg.get('layers')
        if not allowed or layer.name in allowed:
            a01, clip_info = silhouette_clip(a01, patch[..., 3], clip_cfg)
        else:
            clip_info = dict(skipped='layer not in silhouette_clip.layers')
    alpha = a01 * 255.0
    a = a01
    diff = np.abs(rgb - patch[..., :3]).mean(axis=2)
    # cross-fade at the tolerance edge so the swap leaves no seam; only swap where the layer is
    # solid (inside soft alpha the model holds inpainted colour, not the part)
    wgt = np.clip((tolerance - diff) / tolerance, 0, 1)
    wgt = wgt * np.clip((a - alpha_gate) / alpha_ramp, 0, 1)
    if not swap:
        wgt = np.zeros_like(wgt)
    if require_original_alpha:
        # the original's background is transparent (RGB there is not artwork); never import it
        wgt = wgt * np.clip((patch[..., 3] / 255.0 - alpha_gate) / alpha_ramp, 0, 1)
    if alpha_orig_cfg and alpha_orig_cfg.get('enabled', False):
        # pixels whose alpha came from the artwork must carry the artwork's colour as well,
        # otherwise a smooth edge is paired with the model's (differently anti-aliased) colour
        rgb_min = float(alpha_orig_cfg['rgb_min_alpha'])
        wgt = np.maximum(wgt, from_orig_w * (patch[..., 3] / 255.0 >= rgb_min))
    wgt = wgt[..., None]
    out_rgb = rgb * (1 - wgt) + patch[..., :3] * wgt
    img = np.concatenate([out_rgb, alpha[..., None]], axis=2)
    stats = dict(
        pixels=int((a > 0.5).sum()),
        from_original=int(((wgt[..., 0] >= 0.5) & (a > 0.5)).sum()),
        inpainted=int(((wgt[..., 0] < 0.5) & (a > 0.5)).sum()),
        swap_below_alpha_gate=int(((wgt[..., 0] > 0.5) & (patch[..., 3] <= alpha_gate * 255)).sum()),
        mean_swap_weight=float(wgt[a > 0.5].mean()) if (a > 0.5).any() else 0.0,
        mean_color_diff_visible=float(diff[a > alpha_gate].mean()) if (a > alpha_gate).any() else 0.0,
        alpha_from_original_pct=100.0 * float((from_orig_w > 0.5).sum()) / max(int(a.size), 1),
        alpha_from_original_pixels=int((from_orig_w > 0.5).sum()),
        # the edge path takes the artwork's colour down to `rgb_min_alpha`, so the old 0.85 gate
        # alone is no longer the test for "background leaked in": test the background itself
        rgb_from_original_alpha_below_floor=int(((wgt[..., 0] > 0.5) &
                                                 (patch[..., 3] / 255.0 < 0.2)).sum()),
        rgb_min_alpha=float((alpha_orig_cfg or {}).get('rgb_min_alpha', alpha_gate)),
        silhouette_clip=clip_info,
    )
    stats['from_original_pct'] = 100.0 * stats['from_original'] / max(stats['pixels'], 1)
    stats['inpainted_pct'] = 100.0 * stats['inpainted'] / max(stats['pixels'], 1)
    return util.Part(layer.name, img, nx1, ny1), dict(stats=stats, wgt=wgt[..., 0], alpha=a)


def rebuild_all(cfg, orig, mapping, layers, tolerance, skip):
    c = cfg['step4_upscale']
    parts, per_layer = [], {}
    for layer in layers:
        if layer.name in skip:
            continue
        part, info = upscale_layer(layer, mapping, orig, tolerance,
                                   c['swap_alpha_gate'], c['swap_alpha_ramp'],
                                   alpha_cfg=c.get('alpha'),
                                   alpha_orig_cfg=(c.get('alpha') or {}).get('original_alpha'))
        if part is None:
            continue
        parts.append(part)
        per_layer[layer.name] = info
    return parts, per_layer


def eye_roi_mask(cfg, layers, mapping, shape):
    """Pixels of the eye region, excluded from the residual check (rebuilt in step 5)."""
    mask = np.zeros(shape[:2], bool)
    names = set(cfg['step5_eyes']['roi_layers'])
    m = cfg['step5_eyes']['roi_margin_px']
    for layer in layers:
        if layer.name not in names:
            continue
        x1, y1, x2, y2 = mapping.bbox_native(layer.bbox, clip=False)
        xs = slice(max(int(x1) - m, 0), min(int(x2) + m, shape[1]))
        ys = slice(max(int(y1) - m, 0), min(int(y2) + m, shape[0]))
        mask[ys, xs] = True
    return mask


def alpha_edge_steps(part, bins=(0.02, 0.06, 0.12, 0.25, 0.5, 1.01)):
    """Histogram of |alpha(x+1)-alpha(x)| along a layer's soft edge, and the step fraction.

    A staircase edge (a 768px layer magnified 2x) shows up as many neighbouring pairs with a large
    jump and as few distinct alpha levels; a smooth edge puts the mass in the small bins.
    """
    a = part.img[..., 3] / 255.0
    band = (a > 0.02) & (a < 0.98)
    if int(band.sum()) < 20:
        return dict(edge_pixels=int(band.sum()), steps=None, note='no soft edge')
    d = np.concatenate([np.abs(np.diff(a, axis=1))[band[:, 1:] & band[:, :-1]],
                        np.abs(np.diff(a, axis=0))[band[1:, :] & band[:-1, :]]])
    hist, edges = np.histogram(d, bins=bins)
    return dict(
        edge_pixels=int(band.sum()),
        adjacent_pairs=int(d.size),
        abs_delta_hist={f'{edges[i]:.2f}-{edges[i + 1]:.2f}': int(hist[i]) for i in range(len(hist))},
        step_fraction=round(float((d > 0.5).mean()), 4),
        mean_abs_delta=round(float(d.mean()), 4),
        alpha_levels=int(len(np.unique(np.round(a[band] * 255)))),
    )


def paint_part_region(part, mask, orig, feather=2.0):
    """Add artwork pixels (colour + alpha) to a Part inside full-canvas `mask`, extending it if needed."""
    soft = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), feather) if feather > 0 else mask.astype(np.float32)
    # feather outward only: inside the mask the artwork's own alpha must survive a 1px blob
    soft = np.maximum(np.clip(soft, 0, 1), mask.astype(np.float32))
    H, W = orig.shape[:2]
    ys, xs = np.where(soft > 0.02)
    if not len(ys):
        return part, 0
    x0, y0 = min(int(xs.min()), part.left), min(int(ys.min()), part.top)
    x1, y1 = max(int(xs.max()) + 1, part.left + part.size[0]), max(int(ys.max()) + 1, part.top + part.size[1])
    canvas = np.zeros((y1 - y0, x1 - x0, 4), np.float32)
    canvas[part.top - y0:part.top - y0 + part.size[1], part.left - x0:part.left - x0 + part.size[0]] = part.img
    m = soft[y0:y1, x0:x1, None]
    oa = orig[y0:y1, x0:x1, 3:4] / 255.0
    new_a = oa * m
    have_a = canvas[..., 3:4] / 255.0
    canvas[..., :3] = np.where(new_a > 0.5, orig[y0:y1, x0:x1, :3], canvas[..., :3])
    canvas[..., 3:4] = np.maximum(have_a, new_a) * 255.0
    return util.Part(part.name, canvas, x0, y0), int((new_a > 0.02).sum())


def run(cfg, out_root, log=print):
    c = cfg['step4_upscale']
    rc = c['residual']
    out = os.path.join(out_root, 'step4')
    layer_dir = os.path.join(out, 'layers')
    os.makedirs(out, exist_ok=True)

    orig = util.load_rgba(cfg['input']['original_png'])
    H, W = orig.shape[:2]
    psd_size, layers = util.psd_pixel_layers(cfg['input']['psd'])
    mapping = util.Mapping(psd_size, (W, H))
    skip = set(c['skip_layers'])
    tol = c['color_tolerance']

    parts, per_layer = rebuild_all(cfg, orig, mapping, layers, tol, skip)
    util.save_parts(parts, layer_dir)

    # the skipped layers (eyes) are rebuilt in step 5, but their model geometry is still needed:
    # keep a pure upscale of them as reference, never as final pixels
    eye_model = []
    for layer in layers:
        if layer.name not in skip:
            continue
        part, _ = upscale_layer(layer, mapping, orig, tol, swap=False)
        if part is not None:
            eye_model.append(part)
    if eye_model:
        util.save_parts(eye_model, os.path.join(out, 'eye_model'))
    log(f'step4: rebuilt {len(parts)} parts at {W}x{H}, tolerance={tol}')

    # ---- per-layer statistics at the selected tolerance -----------------------
    layer_stats = {name: info['stats'] for name, info in per_layer.items()}

    # ---- threshold comparison -------------------------------------------------
    comp_tiles, comp_labels = [], []
    layer_names = [p.name for p in parts]
    threshold_stats = {}
    for t in c['compare_tolerances']:
        ps_t, info_t = rebuild_all(cfg, orig, mapping, layers, t, skip)
        comp = util.composite(ps_t, (W, H))
        comp_tiles.append(util.thumb(comp, 300))
        comp_labels.append(f'tol={t:g}')
        threshold_stats[str(t)] = {
            name: dict(from_original_pct=info_t[name]['stats']['from_original_pct'],
                       inpainted_pct=info_t[name]['stats']['inpainted_pct'])
            for name in layer_names}
    mask_tiles = []
    for name in layer_names:
        m = (per_layer[name]['wgt'] > 0.5).astype(np.float32)
        vis = np.zeros(m.shape + (3,), np.float32)
        vis[..., 1] = m * 255
        vis[..., 0] = (1 - m) * per_layer[name]['alpha'] * 120
        mask_tiles.append(util.thumb(np.concatenate(
            [vis, per_layer[name]['alpha'][..., None] * 255], axis=2), 150))
    sheet = util.montage(comp_tiles + mask_tiles, cols=max(3, len(layer_names) // 2 + 1),
                         cell=(300, 300), labels=comp_labels + layer_names)
    sheet.save(os.path.join(out, 'check_step4_tolerance.png'))

    # per-layer thumbnails at the selected tolerance
    tiles = [util.thumb(p.img, 170) for p in parts]
    util.montage(tiles, cols=6, cell=(170, 170),
                 labels=[f'{p.name} {layer_stats[p.name]["from_original_pct"]:.0f}%orig'
                         for p in parts]).save(os.path.join(out, 'check_step4_layers.png'))

    # ---- background contamination check --------------------------------------
    bg_probe = float(c['background_probe_alpha'])
    bg_tokens = []
    for p in parts:
        a = p.img[..., 3] / 255.0
        if (a < bg_probe).sum() > 50:
            bg_tokens.append({'layer': p.name,
                              'mean_rgb_low_alpha': np.round(p.img[a < bg_probe][:, :3].mean(axis=0), 1).tolist()})
    orig_transparent = orig[..., 3] < 25
    bg_check = dict(
        original_transparent_pixels=int(orig_transparent.sum()),
        original_transparent_mean_rgb=(np.round(orig[orig_transparent][:, :3].mean(axis=0), 1).tolist()
                                       if orig_transparent.any() else None),
        swapped_on_transparent_original=int(sum(s['rgb_from_original_alpha_below_floor']
                                                for s in layer_stats.values())),
        gate=c['swap_alpha_gate'],
        rgb_min_alpha=float(((c.get('alpha') or {}).get('original_alpha') or {}).get('rgb_min_alpha', 0.85)),
        swappable_below_old_gate=int(sum(s['swap_below_alpha_gate'] for s in layer_stats.values())),
        layer_low_alpha_colours=bg_tokens[:20],
    )

    # ---- residual check -------------------------------------------------------
    canvas = util.composite(parts, (W, H))
    cov = util.coverage_mask(parts, (W, H))
    oa = orig[..., 3] / 255.0
    ca = canvas[..., 3] / 255.0
    diff = np.abs(orig[..., :3] - canvas[..., :3]).mean(axis=2)
    eye_mask = eye_roi_mask(cfg, layers, mapping, orig.shape)

    uncovered = (oa > rc['uncovered_alpha']) & (cov < rc['union_alpha']) & (~eye_mask)
    colour_off = (oa > rc['uncovered_alpha']) & (cov >= rc['union_alpha']) & \
                 (diff > rc['color_diff_threshold']) & (~eye_mask)
    residual = uncovered | colour_off
    blob_list, lab = util.blobs(residual, min_area=1)

    chin = None
    ref = c['residual_layers']['chin_reference_layer']
    for layer in layers:
        if layer.name == ref:
            chin = int(mapping.bbox_native(layer.bbox)[3])
    if chin is None:
        chin = int(H * 0.4)

    grow_base = ((diff > rc['grow_diff_threshold']) & (oa > rc['uncovered_alpha']) & (~eye_mask))
    groups = {c['residual_layers']['neckwear_name']: np.zeros((H, W), bool),
              c['residual_layers']['objects_name']: np.zeros((H, W), bool)}
    kept = []
    for b in blob_list:
        if b['area'] < rc['min_blob_area']:
            continue
        comp = (lab == b['label']).astype(np.uint8)
        grown = np.zeros_like(comp)
        n, l2 = cv2.connectedComponents(grow_base.astype(np.uint8), 8)
        seed_labels = np.unique(l2[comp.astype(bool)])
        for s in seed_labels:
            if s:
                grown |= (l2 == s).astype(np.uint8)
        grown = cv2.dilate(grown, np.ones((3, 3), np.uint8), 1)
        name = (c['residual_layers']['neckwear_name'] if b['centroid'][1] > chin
                else c['residual_layers']['objects_name'])
        groups[name] |= grown.astype(bool)
        kept.append(dict(area=b['area'], bbox=b['bbox'], centroid=b['centroid'],
                         grown_area=int(grown.sum()), assigned=name,
                         below_chin=bool(b['centroid'][1] > chin)))

    feather = float(rc['feather_px'])

    # A residual blob that behaves like hair (dark, inside the hair layer's own box) is a lock the
    # model dropped, not a separate object: merging it back into the hair keeps the hair's own
    # deformation, and a stand-alone `objects` layer there would be drawn beside/under the face.
    hair_merge = (c['residual_layers'].get('hair_merge') or {})
    hair_merged = None
    obj_name = c['residual_layers']['objects_name']
    if hair_merge.get('enabled') and obj_name in groups and groups[obj_name].any():
        donor = next((p for p in parts if p.name == hair_merge['donor_layer']), None)
        if donor is not None:
            mask = groups[obj_name]
            x0 = max(donor.left, 0)
            y0 = max(donor.top, 0)
            x1 = min(donor.left + donor.size[0], W)
            y1 = min(donor.top + donor.size[1], H)
            inside = np.zeros_like(mask)
            inside[y0:y1, x0:x1] = mask[y0:y1, x0:x1]
            inside_pct = 100.0 * float(inside.sum()) / max(int(mask.sum()), 1)
            mean_lum = float(orig[mask][:, :3].mean())
            hair_merged = dict(layer=donor.name, pixels=int(mask.sum()),
                               mean_lum=round(mean_lum, 1),
                               inside_donor_bbox_pct=round(inside_pct, 1),
                               merged=False)
            if inside_pct >= float(hair_merge['min_inside_pct']) and \
                    mean_lum < float(hair_merge['max_mean_lum']):
                donor, added = paint_part_region(donor, mask, orig, feather)
                hair_merged.update(merged=True, added_pixels=added,
                                   reason='dark residual inside the hair layer box')
                groups.pop(obj_name)
                parts = [donor if p.name == donor.name else p for p in parts]
                kept = [k for k in kept if k['assigned'] != obj_name]
            log(f'step4: hair merge {hair_merged}')

    if hair_merged and hair_merged.get('merged'):
        util.save_parts(parts, layer_dir)

    residual_parts = []
    for name, mask in groups.items():
        if not mask.any():
            continue
        soft = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), feather) if feather > 0 else mask.astype(np.float32)
        soft = np.clip(soft * 1.6, 0, 1)
        ys, xs = np.where(soft > 0.02)
        x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        a = (oa * soft)[y0:y1, x0:x1]
        img = np.concatenate([orig[y0:y1, x0:x1, :3], (a * 255)[..., None]], axis=2)
        residual_parts.append(util.Part(name, img, int(x0), int(y0)))
        log(f'step4: residual layer {name} bbox=({x0},{y0},{x1},{y1}) area={int(mask.sum())}')

    res_dir = os.path.join(out, 'residual_layers')
    if residual_parts:
        util.save_parts(residual_parts, res_dir)

    # topwear shadow under the new neckwear
    neck_mask = groups.get(c['residual_layers']['neckwear_name'])
    topwear_shadow = None
    if neck_mask is not None and neck_mask.any():
        tp = [p for p in parts if p.name == 'topwear']
        if tp:
            p = tp[0]
            h, w = p.img.shape[:2]
            m = np.zeros(p.img.shape[:2], bool)
            x0, y0 = max(p.left, 0), max(p.top, 0)
            x1, y1 = min(p.left + w, W), min(p.top + h, H)
            m[y0 - p.top:y1 - p.top, x0 - p.left:x1 - p.left] = neck_mask[y0:y1, x0:x1]
            if m.any():
                topwear_shadow = dict(
                    pixels=int(m.sum()),
                    mean_color_diff_vs_original=float(
                        np.abs(p.img[m][:, :3] - orig[p.top:p.top + h, p.left:p.left + w][m][:, :3]).mean()),
                    action='keep model colour (inpainted) under neckwear',
                )

    # ---- figures --------------------------------------------------------------
    vis = util.on_checker(orig) * 0.35
    vis[residual] = np.array([255, 40, 40], np.float32)
    for b in kept:
        x0, y0, x1, y1 = b['bbox']
        cv2.rectangle(vis, (x0, y0), (x1, y1), (60, 255, 120), 2)
    res_tiles = [vis.astype(np.float32),
                 np.repeat((uncovered * 255)[..., None], 3, axis=2).astype(np.float32),
                 np.repeat((colour_off * 255)[..., None], 3, axis=2).astype(np.float32)]
    for p in residual_parts:
        res_tiles.append(util.thumb(util.composite([p], (W, H)), 400))
    util.montage([util.thumb(t, 400) for t in res_tiles], cols=3, cell=(400, 400),
                 labels=['residual mask on original (boxes = kept blobs)', 'uncovered (no layer alpha)',
                         'covered but colour off'] + [f'new layer: {p.name}' for p in residual_parts]
                 ).save(os.path.join(out, 'check_step4_residual.png'))

    # ---- silhouette alpha smoothness (the 768 -> native staircase) -----------
    edge_metrics = {}
    for p in parts:
        if p.name in ('front hair', 'back hair', 'topwear', 'handwear', 'face'):
            edge_metrics[p.name] = alpha_edge_steps(p)

    metrics = dict(
        step=4,
        canvas=[W, H],
        interpolation=c['interpolation'],
        alpha_pipeline=dict(alpha=c.get('alpha'), applied=True),
        selected_tolerance=tol,
        alpha_gate=c['swap_alpha_gate'],
        layers=layer_stats,
        threshold_comparison=threshold_stats,
        background_check=bg_check,
        alpha_edges=edge_metrics,
        residual=dict(
            uncovered_pixels=int(uncovered.sum()),
            colour_off_pixels=int(colour_off.sum()),
            total_residual_pixels=int(residual.sum()),
            blobs=blob_list[:40],
            blob_count=len(blob_list),
            kept_blobs=kept,
            min_blob_area=rc['min_blob_area'],
            chin_y=chin,
            hair_merge=hair_merged,
            new_layers=[dict(name=p.name, left=p.left, top=p.top,
                             width=p.size[0], height=p.size[1],
                             pixels=int((p.img[..., 3] > 127).sum())) for p in residual_parts],
            topwear_shadow=topwear_shadow,
        ),
        eye_model_layers=[p.name for p in eye_model],
        figures=['check_step4_layers.png', 'check_step4_tolerance.png', 'check_step4_residual.png'],
    )
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    for b in kept:
        log(f'  blob area={b["area"]} bbox={b["bbox"]} -> {b["assigned"]}')
    log(f'step4: residual uncovered={int(uncovered.sum())} colour_off={int(colour_off.sum())}')
    return metrics
