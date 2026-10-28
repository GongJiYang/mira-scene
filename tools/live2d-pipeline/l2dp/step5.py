"""Step 5 - rebuild eyes (sclera / full iris / lashes) per side from the original artwork.

See-through's eye layers are the weakest part of its output: the iris is cut by the lid, the
sclera is a ring, and the lashes are mush. We take geometry from the model + artwork, complete
the iris by mirroring about its horizontal axis, and hand psd2live a *solid* sclera so its
iris-clipping step cannot eat the pupil.
"""
import os

import cv2
import numpy as np

from . import eyegeom, util


# --------------------------------------------------------------------- geometry

def fit_circle(mask):
    """Algebraic (Kasa) circle fit on the lower contour; keeps the lid edge out of the fit."""
    contours, _ = cv2.findContours((mask > 0).astype(np.uint8), cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None
    c = max(contours, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
    ymin, ymax = c[:, 1].min(), c[:, 1].max()
    pts = c[c[:, 1] > ymin + 0.15 * (ymax - ymin)]
    if len(pts) < 20:
        pts = c
    A = np.c_[2 * pts[:, 0], 2 * pts[:, 1], np.ones(len(pts))]
    b = (pts ** 2).sum(axis=1)
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    cx, cy = float(sol[0]), float(sol[1])
    r = float(np.sqrt(sol[2] + cx ** 2 + cy ** 2))
    res = np.abs(np.hypot(pts[:, 0] - cx, pts[:, 1] - cy) - r)
    return dict(cx=cx, cy=cy, r=r, residual_max=float(res.max()),
                residual_mean=float(res.mean()), contour_points=int(len(pts)))


def lash_angle(lum, cx, cy, r, clip_rad=0.45, dark_lum=110.0, radius_ratio=1.6,
               upper_only=True):
    """Principal direction of the lid/lash strokes around the iris (radians)."""
    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    band = np.hypot((xx - cx) / (r * radius_ratio), (yy - cy) / (r * radius_ratio)) < 1.0
    if upper_only:
        band &= yy < cy - 0.1 * r
    dark = (lum < dark_lum) & band
    if dark.sum() < 60:
        return 0.0, 0.0
    pts = np.c_[xx[dark], yy[dark]]
    pts = pts - pts.mean(axis=0)
    cov = np.cov(pts.T)
    evals, evecs = np.linalg.eigh(cov)
    major = evecs[:, int(np.argmax(evals))]
    ang = float(np.arctan2(major[1], major[0]))
    if ang > np.pi / 2:
        ang -= np.pi
    if ang < -np.pi / 2:
        ang += np.pi
    return float(np.clip(ang, -clip_rad, clip_rad)), float(max(evals) / max(evals.min(), 1e-6))


def rim_brightness(iris_rgb, iris_alpha, dist, r_eff, outer_px, inner_px):
    """Mean luminance of the iris's outermost ring vs the ring just inside it.

    A light halo left over from the artwork's anti-aliased edge makes the outer ring brighter than
    the inner one; a clean edge keeps the two close.
    """
    lum = iris_rgb.mean(axis=2)
    solid = iris_alpha > 0.2
    outer = solid & (dist <= r_eff) & (dist > r_eff - outer_px)
    inner = solid & (dist <= r_eff - outer_px) & (dist > r_eff - outer_px - inner_px)
    if outer.sum() < 8 or inner.sum() < 8:
        return dict(outer_ring_px=int(outer.sum()), inner_ring_px=int(inner.sum()),
                    outer_lum=None, inner_lum=None, delta=None)
    o = float(lum[outer].mean())
    i = float(lum[inner].mean())
    return dict(outer_ring_px=int(outer.sum()), inner_ring_px=int(inner.sum()),
                outer_lum=round(o, 2), inner_lum=round(i, 2), delta=round(o - i, 2))


def filter_lash_blobs(dark, cx, cy, rx, ry, tilt, cfg, min_speck_area):
    """Keep the lash line, drop fragments floating away from it.

    A blob survives when enough of it lies in the band hugging the sclera ellipse (the lash line's
    own place) and its centroid is no more than `max_above_px` above the ellipse: stray strokes from
    the hair above the eye fail both, the lash wings and the inner-corner lash pass.
    """
    m = (dark > 0.25).astype(np.uint8)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(m, 8)
    band = cfg
    u, v = eyegeom.ellipse_coords(dark.shape, cx, cy, tilt)
    band_mask = ((u / max(rx * float(band['band_rx_ratio']), 1e-6)) ** 2 +
                 (v / max(ry * float(band['band_ry_ratio']), 1e-6)) ** 2) <= 1.0
    top = cy - ry
    keep = np.zeros_like(m)
    comps = []
    areas = [int(stats[i, cv2.CC_STAT_AREA]) for i in range(1, n)]
    main_label = 1 + int(np.argmax(areas)) if areas else 0
    for i in range(1, n):
        sel = lab == i
        area = int(stats[i, cv2.CC_STAT_AREA])
        inside_pct = 100.0 * float((sel & band_mask).sum()) / max(area, 1)
        above = float(top - cent[i][1])
        # the largest stroke is the lash line itself; every other blob has to sit in the lid band
        kept = (i == main_label or
                (area >= min_speck_area and inside_pct >= float(band['min_inside_pct'])
                 and above <= float(band['max_above_px'])))
        comps.append(dict(area=area, inside_band_pct=round(inside_pct, 1),
                          above_ellipse_px=round(above, 1), kept=bool(kept),
                          centroid=[round(float(cent[i][0]), 1), round(float(cent[i][1]), 1)]))
        if kept:
            keep[sel] = 1
    comps.sort(key=lambda c0: -c0['area'])
    if not keep.any():
        return dark * 0.0, dict(components=comps, kept=0, dropped=len(comps))
    soft = cv2.dilate(keep, np.ones((3, 3), np.uint8), 1)
    soft = cv2.GaussianBlur(soft.astype(np.float32), (3, 3), 0)
    return dark * soft, dict(components=comps, kept=int(sum(c0['kept'] for c0 in comps)),
                             dropped=int(sum(not c0['kept'] for c0 in comps)))


def drop_specks(alpha, min_area):
    m = (alpha > 0.25).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros_like(m)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            keep[lab == i] = 1
    keep = cv2.dilate(keep, np.ones((3, 3), np.uint8), 1)
    return alpha * cv2.GaussianBlur(keep.astype(np.float32), (3, 3), 0)


# ---------------------------------------------------------------- iris colour

def estimate_iris_hue(model_irides, min_sat):
    """Dominant hue of the model's irides layer (HSV peak, weighted by saturation)."""
    mask = model_irides[..., 3] > 128
    if not mask.any():
        return None
    px = np.clip(model_irides[mask][:, :3], 0, 255).astype(np.uint8).reshape(-1, 1, 3)
    hsv = cv2.cvtColor(px, cv2.COLOR_RGB2HSV).reshape(-1, 3)
    sat_ok = hsv[hsv[:, 1] >= min_sat]
    use = sat_ok if len(sat_ok) >= 40 else hsv
    hist = np.bincount(use[:, 0], minlength=180).astype(np.float64)
    hist = cv2.GaussianBlur(hist.reshape(-1, 1), (1, 7), 0).ravel()
    # circular peak: keep the window with the largest mass to survive hue wraparound
    win = 10
    mass = np.array([hist[np.arange(h - win, h + win + 1) % 180].sum() for h in range(180)])
    peak = int(np.argmax(mass))
    return dict(hue_peak=peak,
                hue_window_mass=float(mass[peak] / max(mass.sum(), 1e-9)),
                hue_p10=float(np.percentile(use[:, 0], 10)),
                hue_p90=float(np.percentile(use[:, 0], 90)),
                sat_p50=float(np.percentile(use[:, 1], 50)),
                sat_p90=float(np.percentile(use[:, 1], 90)),
                val_p10=float(np.percentile(use[:, 2], 10)),
                val_p50=float(np.percentile(use[:, 2], 50)),
                val_p90=float(np.percentile(use[:, 2], 90)),
                rgb_median=np.round(np.median(px.reshape(-1, 3), axis=0), 0).tolist(),
                pixels=int(len(hsv)))


def hue_distance(h, center):
    d = np.abs(h.astype(np.int16) - int(center))
    return np.minimum(d, 180 - d)


# --------------------------------------------------------------------- build

def build_eye(rgb, model_masks, iris_mask_extra, center_hint, cfg, side_mask=None):
    """Build (eyewhite, irides, eyelash) RGBA arrays for one eye inside a common ROI box."""
    c = cfg['step5_eyes']
    h, w = rgb.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    lum = rgb.astype(np.float32).mean(axis=2)
    side = np.ones((h, w), np.float32) if side_mask is None else side_mask.astype(np.float32)

    visible = np.clip(cv2.GaussianBlur(model_masks['irides'].astype(np.float32), (3, 3), 0), 0, 1) * side
    union = (((model_masks['irides'] > 0.5) | iris_mask_extra) & (side > 0)).astype(np.uint8)
    fit = fit_circle(union)
    if fit is None:
        raise RuntimeError('iris fit failed')
    cx, cy, r = fit['cx'], fit['cy'], fit['r']

    # --- iris: full disc, real pixels below the lid, mirrored about y = cy ------------
    rim = c['iris_rim']
    r_eff = r - float(rim['shrink_px'])
    dist = np.hypot(xx - cx, yy - cy)
    iris_alpha = util.smoothstep(r_eff + 0.5 - dist, 0.0, float(rim['feather_px']))
    # The artwork's edge pixels are a blend of iris and the light sclera behind it: a pale ring.
    # Sample the iris colour a little further in and stretch it out to the rim (a radial projection)
    # so the rim carries the iris's own colour instead of that matte ring.
    inner_r = max(r_eff - float(rim['decontaminate_px']), 1.0)
    k = np.where(dist > inner_r, inner_r / np.maximum(dist, 1e-3), 1.0)
    sx = np.clip(cx + (xx - cx) * k, 0, w - 1).astype(np.int32)
    sy = np.clip(cy + (yy - cy) * k, 0, h - 1).astype(np.int32)
    vis_src = visible[sy, sx]
    sy_mirror = np.where(sy < cy, np.clip(2 * cy - sy, 0, h - 1), sy).astype(np.int32)
    iris_rgb = rgb[sy_mirror, sx] * (1 - vis_src[..., None]) + rgb[sy, sx] * vis_src[..., None]
    iris_px = iris_alpha > 0.5  # the full disc, before the opening clip
    iris_measured_rgb = np.round(rgb[(iris_alpha > 0.5) & (visible > 0.5)].mean(axis=0), 0).tolist() \
        if ((iris_alpha > 0.5) & (visible > 0.5)).any() else None
    iris_rim = rim_brightness(iris_rgb, iris_alpha, dist, r_eff,
                              float(rim['ring_outer_px']), float(rim['ring_inner_px']))

    # --- sclera: solid ellipse, rotated with the lid ---------------------------------
    tilt, tilt_aniso = lash_angle(lum, cx, cy, r, c['lash_angle_clip_rad'], c['lash_lum'],
                                  c['lash_angle_radius_ratio'], c['lash_angle_upper_only'])
    ca, sa = np.cos(tilt), np.sin(tilt)
    u = (xx - cx) * ca + (yy - cy) * sa
    v = -(xx - cx) * sa + (yy - cy) * ca
    open_rx, open_ry = r * c['sclera_rx_ratio'], r * c['sclera_ry_ratio']
    opening_ellipse = util.smoothstep(1.0 - ((u / open_rx) ** 2 + (v / open_ry) ** 2), -0.12, 0.30)
    # The sclera may not stick out of the lid: clip it to the opening the artwork actually drew
    # (between the upper lash's lower edge and the lower lid line), taken from the original pixels.
    art_opening, opening_info = eyegeom.artwork_opening(
        rgb, np.full(lum.shape, 255.0, np.float32),
        cx, cy, open_rx, open_ry, tilt, c['sclera_opening'], lash_lum=c['lash_lum'])
    opening = opening_ellipse if art_opening is None else opening_ellipse * art_opening
    # The iris may not reach past the lid either: outside the aperture the artwork has no eye, so
    # an iris pixel there is the eyeball showing through the face (the outline the user sees, and
    # the whole eyeball when the gaze drops). Both the sclera and the iris end on the same opening.
    iris_clipped = 0
    if c.get('iris_clip_to_opening', True):
        iris_clipped = int(((iris_alpha > 0.2) & (opening <= 0.1)).sum())
        # A wide feather on this clip leaves semi-transparent iris pixels over the pale sclera,
        # which reads as a pale ring around the iris. Keep the clip edge about one pixel wide.
        soft = float(c.get('iris_clip_softness', 0.06))
        iris_alpha = iris_alpha * util.smoothstep(opening, 0.5 - soft, 0.5 + soft)
    inside = (opening_ellipse > 0.6) & (iris_alpha < 0.15)
    if inside.sum() > 40:
        vals = rgb[inside]
        p = np.percentile(vals.mean(axis=1), c['sclera_bright_percentile'])
        bright = vals[vals.mean(axis=1) >= p]
        base = np.median(bright, axis=0).astype(np.float32)
    else:
        base = np.array([228, 226, 230], np.float32)
    mix = float(c['sclera_neutral_mix'])
    base = (1 - mix) * base + mix * np.full(3, base.mean(), np.float32)
    base = np.clip(base * c['sclera_gain'], 0, 255)
    if c.get('sclera_tint'):
        # The artwork's sclera reads as plain white; a light grey-blue with a darker top reads as
        # an eyeball with volume instead of a flat cut-out.
        tm = float(c.get('sclera_tint_mix', 0.5))
        base = np.clip((1 - tm) * base + tm * np.asarray(c['sclera_tint'], np.float32), 0, 255)
    top_shadow = np.clip((v + open_ry) / (2 * open_ry), 0, 1)[..., None]
    gain = 1.0 - c['sclera_top_shadow']
    sclera_rgb = base * (gain + c['sclera_top_shadow'] * top_shadow)

    # --- lashes: the artwork's own dark strokes --------------------------------------
    rx_l, ry_l = r * c['lash_radius_ratio'][0], r * c['lash_radius_ratio'][1]
    near = np.hypot((xx - cx) / rx_l, (yy - cy) / ry_l) < 1.0
    ramp = c['lash_lum_band']
    dark = util.smoothstep(c['lash_lum'] + ramp / 2 - lum, 0.0, ramp) * near * (1 - iris_alpha)
    lash_info = None
    if c.get('lash_blobs', {}).get('enabled'):
        dark, lash_info = filter_lash_blobs(dark, cx, cy, open_rx, open_ry, tilt,
                                            c['lash_blobs'], c['lash_min_speck_area'])
    dark = drop_specks(dark, int(c.get('lash_residual_speck_area', 4)))

    # --- upper-lid shadow: a soft cool band cast by the lid onto the eyeball ----------
    shadow_rgb = np.zeros((h, w, 3), np.float32)
    shadow_alpha = np.zeros((h, w), np.float32)
    sh = c.get('eyelid_shadow') or {}
    if sh.get('enabled'):
        # t = 0 on the lid (top of the opening), 1 on the lower rim; the band fades out downwards
        t = np.clip((v + open_ry) / (2 * open_ry), 0.0, 1.0)
        fade = max(float(sh.get('fade_at', 0.62)), 1e-3)
        grad = np.clip(1.0 - t / fade, 0.0, 1.0) ** float(sh.get('gamma', 1.2))
        shadow_alpha = opening * grad * float(sh.get('opacity', 0.8))
        shadow_rgb[:] = np.asarray(sh.get('tint', [150, 160, 190]), np.float32)

    layers = dict(
        eyewhite=np.concatenate([sclera_rgb, (opening * 255)[..., None]], axis=2),
        irides=np.concatenate([iris_rgb, (iris_alpha * 255)[..., None]], axis=2),
        eyeshadow=np.concatenate([shadow_rgb, (shadow_alpha * 255)[..., None]], axis=2),
        eyelash=np.concatenate([rgb, (dark * 255)[..., None]], axis=2),
    )
    params = dict(
        center=[round(cx, 2), round(cy, 2)], radius=float(round(r, 2)),
        fit=fit, lash_angle_deg=float(round(np.degrees(tilt), 2)),
        lash_angle_anisotropy=float(round(tilt_aniso, 2)),
        ellipse=dict(rx=float(round(open_rx, 2)), ry=float(round(open_ry, 2)),
                     rotation_deg=float(round(np.degrees(tilt), 2))),
        sclera_rgb=[round(float(x), 1) for x in base],
        sclera_pixels=int(inside.sum()),
        sclera_opening=dict(art=opening_info, alpha_pixels=int((opening > 0.5).sum()),
                            ellipse=dict(rx=float(round(open_rx, 2)), ry=float(round(open_ry, 2)),
                                         rotation_deg=float(round(np.degrees(tilt), 2))),
                            ry_ratio=c['sclera_ry_ratio']),
        iris_rim=iris_rim,
        iris_radius_effective=float(round(r_eff, 2)),
        lash_blobs=lash_info,
        iris_measured_rgb=iris_measured_rgb,
        iris_alpha_pixels=int((iris_alpha > 0.5).sum()),
        iris_clipped_to_opening=iris_clipped,
        lash_alpha_pixels=int((dark > 0.2).sum()),
        lash_vertical_extent=int(np.ptp(np.where(dark > 0.2)[0]) + 1) if (dark > 0.2).any() else 0,
        center_hint=center_hint,
    )
    return layers, params, dict(opening=opening, art_opening=art_opening, opening_info=opening_info)


def make_part(name, arr, origin, blend='normal'):
    """arr is ROI-local; origin is where the ROI sits on the native canvas."""
    return util.Part(name, arr, origin[0], origin[1], blend=blend)


def run(cfg, out_root, log=print):
    c = cfg['step5_eyes']
    out = os.path.join(out_root, 'step5')
    layer_dir = os.path.join(out, 'layers')
    os.makedirs(out, exist_ok=True)

    orig = util.load_rgba(cfg['input']['original_png'])
    H, W = orig.shape[:2]
    step4_eyes = os.path.join(out_root, 'step4', 'eye_model')
    parts = {p.name: p for p in util.load_parts(step4_eyes)}
    missing = [n for n in c['roi_layers'] if n not in parts]
    if missing:
        raise RuntimeError(f'step4 layers missing: {missing}')

    # ROI = union of the model eye layers + margin
    m = int(c['roi_margin_px'])
    x0 = min(parts[n].left for n in c['roi_layers']) - m
    y0 = min(parts[n].top for n in c['roi_layers']) - m
    x1 = max(parts[n].left + parts[n].size[0] for n in c['roi_layers']) + m
    y1 = max(parts[n].top + parts[n].size[1] for n in c['roi_layers']) + m
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W), min(y1, H)
    roi = orig[y0:y1, x0:x1, :3].copy()
    roi_h, roi_w = roi.shape[:2]
    log(f'step5: eye ROI = ({x0},{y0})-({x1},{y1})')

    def model_mask(name):
        p = parts[name]
        full = np.zeros((roi_h, roi_w), np.float32)
        ax0, ay0 = max(p.left, x0), max(p.top, y0)
        ax1, ay1 = min(p.left + p.size[0], x1), min(p.top + p.size[1], y1)
        if ax1 > ax0 and ay1 > ay0:
            full[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = \
                p.img[ay0 - p.top:ay1 - p.top, ax0 - p.left:ax1 - p.left, 3] / 255.0
        return full

    model = {n: model_mask(n) for n in c['roi_layers']}

    # ---- iris colour from the model's irides layer ---------------------------
    irides_part = parts['irides']
    iris_colour = estimate_iris_hue(irides_part.img, c['iris_hue_min_sat'])
    hue_c, hue_tol = iris_colour['hue_peak'], c['iris_hue_tolerance']
    log(f'step5: iris hue peak={hue_c} tol={hue_tol} sat_p50={iris_colour["sat_p50"]:.0f}')

    # ---- eye-side split by image midline -------------------------------------
    mid = W / 2.0
    # '-l' is the character's own left eye: the right side of the image for a front-facing model
    name_for = {'right': 'l' if c['side_left_is_image_right'] else 'r',
                'left': 'r' if c['side_left_is_image_right'] else 'l'}

    # ---- detect iris pixels in the artwork, per side ------------------------
    hsv = cv2.cvtColor(roi.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.int16)
    hh, ss, vv = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    vlo, vhi = c['iris_val_range']
    iris_like = ((hue_distance(hh, hue_c) <= hue_tol) & (ss >= c['iris_hue_min_sat']) &
                 (vv >= vlo) & (vv <= vhi)).astype(np.uint8)
    iris_like = cv2.morphologyEx(iris_like, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    blob_list, lab = util.blobs(iris_like, min_area=int(c['iris_min_area']))
    blob_list = blob_list[:2]

    ys, xs = np.mgrid[0:roi_h, 0:roi_w]
    gx = xs + x0

    # An extra iris source (the See-through rebuild's complete circle) may be supplied by the
    # segly adapter: it widens the circle fit without pretending those pixels are visible in the
    # artwork (that is what model_masks['irides'] still reports).
    extra_iris = None
    if c.get('extra_iris_from_source'):
        p = os.path.join(out_root, 'step4', 'eye_model_extra', 'irides.png')
        if os.path.exists(p):
            j = util.read_json(os.path.join(out_root, 'step4', 'eye_model_extra', 'irides.json'))
            img = util.load_rgba(p)
            ox, oy = j['origin']
            extra_iris = np.zeros((roi_h, roi_w), bool)
            ax0, ay0 = max(ox, x0), max(oy, y0)
            ax1, ay1 = min(ox + img.shape[1], x1), min(oy + img.shape[0], y1)
            if ax1 > ax0 and ay1 > ay0:
                extra_iris[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = \
                    img[ay0 - oy:ay1 - oy, ax0 - ox:ax1 - ox, 3] > 127
            log(f'step5: extra iris source loaded ({int(extra_iris.sum())}px in ROI)')

    per_side = {}
    for b in blob_list:
        name = name_for['right' if b['centroid'][0] + x0 > mid else 'left']
        per_side.setdefault(name, b)

    expected_range = c['expected_iris_radius']['range']
    expected_width = c['expected_iris_radius']['width_px']
    scaled_expected = [round(v * W / expected_width, 2) for v in expected_range]

    results, new_parts, eye_arrays = {}, [], {}
    for name in sorted(per_side, key=lambda n: -per_side[n]['centroid'][0]):
        b = per_side[name]
        on_right = b['centroid'][0] + x0 > mid
        side_bool = (gx > mid) if on_right else (gx < mid)
        extra = ((lab == b['label']) & side_bool)
        if extra_iris is not None:
            extra = extra | (extra_iris & side_bool)
        layers, params, extra_info = build_eye(roi, model, extra, b['centroid'], cfg,
                                               side_mask=side_bool)
        # the artwork opening, on the native canvas, for the export check (sclera outside it = 0)
        opening_full = np.zeros((H, W), np.float32)
        opening_full[y0:y1, x0:x1] = extra_info['opening']
        util.save_rgba(np.concatenate([np.repeat((opening_full * 255)[..., None], 3, axis=2),
                                       (opening_full * 255)[..., None]], axis=2),
                       os.path.join(out, f'opening-{name}.png'))

        # keep only this side of the midline (lashes reach past the iris)
        side_soft = side_bool.astype(np.float32)[..., None]
        for k in layers:
            layers[k][..., 3:4] = layers[k][..., 3:4] * side_soft

        params.update(side=name, image_side='right' if on_right else 'left',
                      center_native=[round(params['center'][0] + x0, 2),
                                     round(params['center'][1] + y0, 2)],
                      expected_radius=scaled_expected,
                      radius_vs_expected_ratio=round(
                          params['radius'] / float(np.mean(scaled_expected)), 2),
                      detected_blob=b)
        results[name] = params
        eye_arrays[name] = layers
        for k, arr in layers.items():
            new_parts.append(make_part(f'{k}-{name}', arr, (x0, y0),
                                       blend=c.get('layer_blend', {}).get(k, 'normal')))
        log(f'  eye {name} ({params["image_side"]} side of image): center={params["center"]} '
            f'r={params["radius"]} residual={params["fit"]["residual_mean"]:.2f}/'
            f'{params["fit"]["residual_max"]:.2f}px tilt={params["lash_angle_deg"]:.1f}deg')

    # ordering: eyewhite-l/r, irides-l/r, eyelash-l/r
    order = [f'{k}-{s}' for k in c['eye_order'] for s in ('l', 'r')]
    new_parts.sort(key=lambda p: order.index(p.name) if p.name in order else 99)
    util.save_parts(new_parts, layer_dir)

    # ---- figures: eye ROI at 4x ---------------------------------------------
    z = int(c['zoom_factor'])
    rebuilt = util.composite(new_parts, (W, H))[y0:y1, x0:x1]
    orig_crop = orig[y0:y1, x0:x1]
    sclera_iris = util.composite([p for p in new_parts if not p.name.startswith('eyelash')], (W, H))[y0:y1, x0:x1]
    lashes_only = util.composite([p for p in new_parts if p.name.startswith('eyelash')], (W, H))[y0:y1, x0:x1]

    def zoom(a, checker=True):
        rgb = util.thumb(a, max_side=10 ** 6, checker=checker)
        return cv2.resize(rgb, (rgb.shape[1] * z, rgb.shape[0] * z), interpolation=cv2.INTER_NEAREST)

    tiles = [zoom(orig_crop), zoom(rebuilt), zoom(util.overlay50(orig_crop, rebuilt)),
             zoom(sclera_iris), zoom(lashes_only)]
    labels = ['original x4', 'rebuilt (all eye layers) x4', 'overlay 50% x4',
              'sclera+iris only x4', 'lashes only x4']
    util.montage(tiles, cols=2, cell=(tiles[0].shape[1], tiles[0].shape[0]),
                 labels=labels).save(os.path.join(out, 'check_step5_eyes.png'))

    # per-eye zoom (each eye alone)
    per_eye = []
    for name in sorted(results):
        cx, cy = results[name]['center'][0] + x0, results[name]['center'][1] + y0
        pad = int(results[name]['radius'] * 3.2)
        bx0, by0 = max(int(cx) - pad, 0), max(int(cy) - pad, 0)
        bx1, by1 = min(int(cx) + pad, W), min(int(cy) + pad, H)
        o = orig[by0:by1, bx0:bx1]
        r_ = util.composite(new_parts, (W, H))[by0:by1, bx0:bx1]
        per_eye += [zoom(o), zoom(r_), zoom(util.overlay50(o, r_))]
    util.montage(per_eye, cols=3, cell=(per_eye[0].shape[1], per_eye[0].shape[0]),
                 labels=[f'{n} orig' if i % 3 == 0 else f'{n} rebuilt' if i % 3 == 1 else f'{n} overlay'
                         for n in sorted(results) for i in range(3)]).save(
        os.path.join(out, 'check_step5_per_eye.png'))

    metrics = dict(
        step=5,
        roi=[x0, y0, x1, y1],
        iris_colour_estimate=iris_colour,
        hue_window=[int(hue_c - hue_tol), int(hue_c + hue_tol)],
        eyes=results,
        expected_radius_scaled=scaled_expected,
        expected_radius_note=dict(reference_width_px=expected_width,
                                  reference_range=expected_range,
                                  scaled_by=f'{W}/{expected_width}'),
        layers=[p.name for p in new_parts],
        iris_rim={n: results[n]['iris_rim'] for n in results},
        sclera_opening={n: results[n]['sclera_opening'] for n in results},
        lash_blobs={n: (results[n]['lash_blobs'] or {}) for n in results},
        figures=['check_step5_eyes.png', 'check_step5_per_eye.png'],
    )
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    return metrics
