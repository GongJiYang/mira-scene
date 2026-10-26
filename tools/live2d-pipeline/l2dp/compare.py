"""Comparison step - the eight issues of fix round 1, measured on two runs side by side.

Every number here is computed from artefacts a run already wrote (step4/step5/step6 layers,
step8 posed exports) plus the original artwork, so the same code produces the baseline and the
new run: nothing is re-implemented for one side. Each issue gets a figure with the two runs
stacked and a row of numbers.
"""
import glob
import os
import subprocess

import cv2
import numpy as np

from . import eyegeom, repair, step4, util

SIDES = ('l', 'r')
OPENING_CFG = dict(skin_diff_thr=34.0, lash_extra_lum=40.0, close_px=5, erode_px=0,
                   feather_px=1.2, exclude_lash_dark=False,
                   skin_warm_thr=20.0, skin_warm_min_lum=115.0, skin_warm_dist_max=90.0)


# ------------------------------------------------------------------ run access

class Run:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.name = os.path.basename(self.root)
        self.s4 = self._metrics('step4')
        self.s5 = self._metrics('step5')
        self.s6 = self._metrics('step6')
        self.s8 = self._metrics('step8')
        # pose directories this run did not export itself (an older baseline), filled by build()
        self.extra_poses = {}

    def _metrics(self, step):
        p = os.path.join(self.root, step, 'metrics.json')
        return util.read_json(p) if os.path.exists(p) else None

    def path(self, *parts):
        p = os.path.join(self.root, *parts)
        return p if os.path.exists(p) else None

    @property
    def parts4(self):
        p = self.path('step4', 'layers', 'index.json')
        return util.load_parts(os.path.dirname(p)) if p else []

    @property
    def eye_parts(self):
        p = self.path('step5', 'layers', 'index.json')
        return util.load_parts(os.path.dirname(p)) if p else []

    def part(self, layer_dir, name):
        p = self.path(*layer_dir, f'{name}.png')
        if not p:
            return None
        origin = util.read_json(self.path(*layer_dir, f'{name}.json'))
        return util.Part(name, util.load_rgba(p), *origin['origin'])

    def pose(self, tag):
        p = self.path('step8', f'pose_{tag}.png')
        if p:
            return util.load_rgba(p)
        extra = (self.extra_poses or {}).get(tag)
        if not extra:
            return None
        q = os.path.join(extra, f'pose_{tag}.png')
        return util.load_rgba(q) if os.path.exists(q) else None

    def posed_layers(self, tag):
        extra = (self.extra_poses or {}).get(tag)
        d = extra or os.path.join(self.root, 'step8', 'p0' if tag == 'rest' else tag)
        psds = sorted(glob.glob(os.path.join(d, '*.psd')))
        if not psds:
            return None, None
        from psd_tools import PSDImage
        psd = PSDImage.open(psds[0])
        out = [(l.name, l.bbox, util.layer_rgba(l)) for l in psd.descendants() if l.kind == 'pixel']
        return psd.size, out

    def flattened(self):
        p = self.path('step6', 'flattened.png')
        return util.load_rgba(p) if p else None

    def layer_box(self, name):
        for src in (self.s6 or {}).get('layers') or []:
            if src['name'] == name:
                return [src['left'], src['top'], src['left'] + src['width'], src['top'] + src['height']]
        p = self.part(('step4', 'layers'), name)
        return [p.left, p.top, p.left + p.size[0], p.top + p.size[1]] if p else None

    def variant_part(self, name):
        if not self.path('step6', 'variant_layers', 'index.json'):
            return None
        return self.part(('step6', 'variant_layers'), name)

    def mouth_mask(self):
        """The unified mouth mask this run cut its mouth states to, or None when it has none."""
        p = self.path('step6', 'mouth_mask.png')
        return util.load_rgba(p)[..., 0] / 255.0 if p else None

    def mouth_support(self):
        """Canvas-space alpha support of the run's mouth state layers.

        run4 writes the mask it cut them to; an older run without that file gets the maximum of its
        mouth layers' alpha, which is the support it effectively drew.
        """
        mask = self.mouth_mask()
        if mask is not None:
            return mask
        size = (self.s6 or {}).get('canvas') or [1024, 1536]
        W, H = int(size[0]), int(size[1])
        out = np.zeros((H, W), np.float32)
        for name in ('mouth close', 'mouth open', 'mouth small'):
            p = self.variant_part(name)
            if p is None:
                continue
            h, w = p.img.shape[:2]
            out[max(p.top, 0):p.top + h, max(p.left, 0):p.left + w] = np.maximum(
                out[max(p.top, 0):p.top + h, max(p.left, 0):p.left + w], p.img[..., 3] / 255.0)
        return out


def alpha_of(entry, size):
    name, bbox, rgba = entry
    out = np.zeros((size[1], size[0]), np.float32)
    x0, y0 = max(bbox[0], 0), max(bbox[1], 0)
    x1, y1 = min(bbox[2], size[0]), min(bbox[3], size[1])
    if x1 > x0 and y1 > y0:
        out[y0:y1, x0:x1] = rgba[y0 - bbox[1]:y1 - bbox[1], x0 - bbox[0]:x1 - bbox[0], 3] / 255.0
    return out


def combined_alpha(layers, name, size):
    out = np.zeros((size[1], size[0]), np.float32)
    for entry in layers:
        if entry[0] == name:
            np.maximum(out, alpha_of(entry, size), out=out)
    return out


# --------------------------------------------------------------- shared masks

def skin_mask(rgb, ref, chroma_thr=0.10, min_lum=50.0):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    norm = rgb / np.maximum(rgb.mean(axis=2, keepdims=True), 1e-3)
    ref_norm = ref / max(float(np.mean(ref)), 1e-3)
    chroma = np.abs(norm - ref_norm).mean(axis=2)
    return (r > g + 6) & (g > b) & (chroma < chroma_thr) & (rgb.mean(axis=2) > min_lum)


def face_skin(orig, box):
    x0, y0, x1, y1 = box
    patch = orig[y0:y1, x0:x1]
    gate = patch[..., 3] > 200
    return np.median(patch[gate][:, :3], axis=0).astype(np.float32) if gate.sum() > 50 \
        else np.array([232, 198, 183], np.float32)


def opening_for(run, side, orig, H, W):
    """The artwork's eye opening for this run's eye geometry (same derivation step 5 uses)."""
    eye = ((run.s5 or {}).get('eyes') or {}).get(side)
    if not eye:
        return None, None
    cx, cy = eye['center_native']
    rx, ry = eye['ellipse']['rx'], eye['ellipse']['ry']
    tilt = np.radians(eye['ellipse']['rotation_deg'])
    pad = int(max(rx, ry) * 1.8)
    x0, y0 = max(int(cx) - pad, 0), max(int(cy) - pad, 0)
    x1, y1 = min(int(cx) + pad, W), min(int(cy) + pad, H)
    rgb = orig[y0:y1, x0:x1, :3]
    soft, info = eyegeom.artwork_opening(rgb, np.full(rgb.shape[:2], 255.0, np.float32),
                                        cx - x0, cy - y0, rx, ry, tilt, OPENING_CFG, lash_lum=110.0)
    full = np.zeros((H, W), np.float32)
    if soft is not None:
        full[y0:y1, x0:x1] = soft
    else:
        u, v = eyegeom.ellipse_coords((H, W), cx, cy, tilt)
        full = (((u / max(rx, 1e-6)) ** 2 + (v / max(ry, 1e-6)) ** 2) <= 1.0).astype(np.float32)
    return full, [x0, y0, x1, y1]


def iris_like(rgba, hue, tol=22, min_sat=30, vrange=(20, 190)):
    if hue is None:
        return np.zeros(rgba.shape[:2], bool)
    hsv = cv2.cvtColor(np.clip(rgba[..., :3], 0, 255).astype(np.uint8),
                       cv2.COLOR_RGB2HSV).astype(np.int16)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    d = np.abs(h - int(hue))
    d = np.minimum(d, 180 - d)
    return (d <= tol) & (s >= min_sat) & (v >= vrange[0]) & (v <= vrange[1]) & (rgba[..., 3] > 128)


# --------------------------------------------------------------------- issues

def issue1_holes(run, orig, cfg):
    """Hole pixels: artwork opaque, composite not; split into interior and silhouette edge."""
    flat = run.flattened()
    if flat is None:
        return dict(na='no flattened.png')
    oa = orig[..., 3] / 255.0
    fa = flat[..., 3] / 255.0
    mask = (oa > 0.5) & (fa < 0.5)
    enclosed = repair.interior_transparency(fa)
    regions = {}
    blobs, lab = util.blobs(mask, 1)
    priority = ['eyewhite-l', 'eyewhite-r', 'irides-l', 'irides-r', 'eyelash-l', 'eyelash-r',
                'eye close-l', 'eye close-r', 'eyebrow', 'mouth close', 'mouth open', 'mouth',
                'nose', 'ears', 'earwear', 'face', 'neck', 'neckwear', 'topwear', 'handwear',
                'back hair', 'front hair']
    boxes = {}
    for n in priority:
        b = run.layer_box(n)
        if b:
            boxes[n] = b
    for b in blobs:
        cx, cy = b['centroid']
        owner = 'other'
        for n in priority:
            bb = boxes.get(n)
            if bb and bb[0] <= cx < bb[2] and bb[1] <= cy < bb[3]:
                owner = n
                break
        sel = lab == b['label']
        r = regions.setdefault(owner, dict(pixels=0, interior=0, blobs=0))
        r['pixels'] += b['area']
        r['interior'] += int((sel & enclosed).sum())
        r['blobs'] += 1
    out = dict(total=int(mask.sum()), interior=int((mask & enclosed).sum()),
               edge=int((mask & ~enclosed).sum()), regions=regions)
    # the band the architect pointed at: below the chin, above the collar
    fb = run.layer_box('face')
    if fb:
        y0 = max(fb[3] - 40, 0)
        y1 = min(fb[3] + 110, orig.shape[0])
        x0 = max(fb[0] - 40, 0)
        x1 = min(fb[2] + 40, orig.shape[1])
        ref = face_skin(orig, [fb[0], fb[1] + int((fb[3] - fb[1]) * 0.5), fb[2], fb[3] - 20])
        band = np.zeros(mask.shape, bool)
        band[y0:y1, x0:x1] = True
        skin = skin_mask(orig[..., :3], ref)
        sel = band & skin & (oa > 0.5)
        d = np.abs(orig[..., :3] - flat[..., :3]).mean(axis=2)
        out['chin_collar_band'] = dict(
            zone=[x0, y0, x1, y1], pixels=int(sel.sum()),
            hole_pixels=int((mask & sel).sum()),
            transparent_band_pixels=int((sel & (fa < 0.95)).sum()),
            mean_color_diff=round(float(d[sel].mean()), 2) if sel.any() else None,
            max_color_diff=round(float(d[sel].max()), 2) if sel.any() else None)
    return out


def issue2_hair_strip(run, orig, cfg):
    """Colour error inside the hair boxes: catches the skin-coloured strip on the right side."""
    flat = run.flattened()
    if flat is None:
        return dict(na='no flattened.png')
    oa = orig[..., 3] / 255.0
    fa = flat[..., 3] / 255.0
    d = np.abs(orig[..., :3] - flat[..., :3]).mean(axis=2)
    gate = (oa > 0.5) & (fa > 0.5)
    out = {}
    for name in ('front hair', 'back hair'):
        b = run.layer_box(name)
        if not b:
            continue
        sel = np.zeros(d.shape, bool)
        sel[b[1]:b[3], b[0]:b[2]] = True
        sel &= gate
        out[name] = dict(box=b, pixels=int(sel.sum()),
                         mean_color_diff=round(float(d[sel].mean()), 2) if sel.any() else None,
                         max_color_diff=round(float(d[sel].max()), 2) if sel.any() else None)
    # the architect's box: the colour error that was the skin-coloured strip
    strip = [590, 120, 720, 380]
    sel = np.zeros(d.shape, bool)
    sel[strip[1]:strip[3], strip[0]:strip[2]] = True
    sel &= gate
    out['strip_zone'] = dict(zone=strip, pixels=int(sel.sum()),
                             mean_color_diff=round(float(d[sel].mean()), 2) if sel.any() else None,
                             max_color_diff=round(float(d[sel].max()), 2) if sel.any() else None)
    obj = run.part(('step4', 'residual_layers'), 'objects') if run.path(
        'step4', 'residual_layers', 'index.json') else None
    out['objects_layer'] = dict(present=obj is not None,
                                pixels=int((obj.img[..., 3] > 127).sum()) if obj is not None else 0,
                                bbox=[obj.left, obj.top, obj.left + obj.size[0],
                                      obj.top + obj.size[1]] if obj is not None else None)
    hm = ((run.s4 or {}).get('residual') or {}).get('hair_merge')
    out['hair_merge'] = hm
    return out


def issue3_closed_eye(run, orig, cfg, assets):
    """Iris pixels left inside the eye opening when the eye is shut, and distance to the artist's lid."""
    H, W = orig.shape[:2]
    hue = ((run.s5 or {}).get('iris_colour_estimate') or {}).get('hue_peak')
    eyelid = util.load_rgba(assets['eye_close']) if assets.get('eye_close') else None
    out = {}
    for side in SIDES:
        opening, _box = opening_for(run, side, orig, H, W)
        pose = run.pose('p1' if side == 'l' else 'p3')
        rest = run.pose('rest')
        if pose is None or opening is None:
            out[side] = dict(na=True)
            continue
        m = iris_like(pose, hue)
        rec = dict(pose='p1' if side == 'l' else 'p3',
                   opening_pixels=int((opening > 0.5).sum()),
                   closed_iris_pixels=int((m & (opening > 0.5)).sum()),
                   rest_iris_pixels=int((iris_like(rest, hue) & (opening > 0.5)).sum())
                   if rest is not None else None)
        eye = run.s5['eyes'][side]
        cx, cy = eye['center_native']
        pad = int(max(eye['ellipse']['rx'], eye['ellipse']['ry']) * 1.5)
        x0, y0 = max(int(cx) - pad, 0), max(int(cy) - pad, 0)
        x1, y1 = min(int(cx) + pad, W), min(int(cy) + pad, H)
        rec['roi'] = [x0, y0, x1, y1]
        if eyelid is not None:
            ref = eyelid[y0:y1, x0:x1]
            gate = ref[..., 3] > 128
            got = pose[y0:y1, x0:x1]
            rec['vs_artist_lid'] = dict(
                pixels=int(gate.sum()),
                mean_color_diff=round(float(np.abs(got[..., :3] - ref[..., :3])[gate].mean()), 2)
                if gate.any() else None)
        out[side] = rec
    return out


def issue4_mouth(run, orig, cfg, assets):
    """How much the mouth actually changes between shut and open."""
    box = run.layer_box('mouth') or run.layer_box('mouth close')
    out = {}
    if not box:
        return dict(na='no mouth layer')
    padx, pady = int((box[2] - box[0]) * 0.4), int((box[3] - box[1]) * 0.4)
    x0, y0 = max(box[0] - padx, 0), max(box[1] - pady, 0)
    x1, y1 = min(box[2] + padx, orig.shape[1]), min(box[3] + pady, orig.shape[0])
    out['roi'] = [x0, y0, x1, y1]
    rest, open1, half = run.pose('rest'), run.pose('p4'), run.pose('p7')

    def diff(a, b):
        if a is None or b is None:
            return None
        aa, bb = a[y0:y1, x0:x1], b[y0:y1, x0:x1]
        d = np.abs(aa[..., :3] - bb[..., :3]).mean(axis=2)
        sel = (aa[..., 3] > 32) | (bb[..., 3] > 32)
        return dict(diff_pixels=int((d > 10.0).sum()),
                    mean_color_diff=round(float(d[sel].mean()), 2) if sel.any() else None)

    out['open_vs_rest'] = diff(rest, open1)
    out['half_open_vs_rest'] = diff(rest, half)
    for key, tag in (('mouth_open', 'p4'), ('mouth_small', 'p7')):
        img = run.pose(tag)
        if img is None or not assets.get(key):
            continue
        ref = util.load_rgba(assets[key])[y0:y1, x0:x1]
        got = img[y0:y1, x0:x1]
        gate = ref[..., 3] > 128
        out[f'{tag}_vs_artist_{key}'] = dict(
            pixels=int(gate.sum()),
            mean_color_diff=round(float(np.abs(got[..., :3] - ref[..., :3])[gate].mean()), 2)
            if gate.any() else None)
    return out


def issue5_iris_rim(run, orig, cfg):
    """Brightness of the iris's outer 2px ring against the 3px ring inside it.

    Measured only inside the artwork's eye opening: the clip that keeps the iris behind the lid
    removes pixels outside it, so including them compares two different regions between runs.
    """
    out = {}
    H, W = orig.shape[:2]
    for side in SIDES:
        p = run.part(('step5', 'layers'), f'irides-{side}')
        eye = ((run.s5 or {}).get('eyes') or {}).get(side)
        if p is None or not eye:
            out[side] = dict(na=True)
            continue
        opening, _ = opening_for(run, side, orig, H, W)
        vis = np.ones(p.img.shape[:2], bool) if opening is None else \
            opening[p.top:p.top + p.img.shape[0], p.left:p.left + p.img.shape[1]] > 0.5
        cx, cy = eye['center'][0], eye['center'][1]
        h, w = p.img.shape[:2]
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        dist = np.hypot(xx - cx, yy - cy)
        r_eff = eye.get('iris_radius_effective', eye['radius'])
        a = p.img[..., 3] / 255.0
        lum = p.img[..., :3].mean(axis=2)
        solid = (a > 0.2) & vis
        outer = solid & (dist <= r_eff) & (dist > r_eff - 2.0)
        inner = solid & (dist <= r_eff - 2.0) & (dist > r_eff - 5.0)
        out[side] = dict(
            radius=eye['radius'], radius_effective=r_eff,
            visible_px=int(vis.sum()),
            outer_ring_px=int(outer.sum()), inner_ring_px=int(inner.sum()),
            outer_lum=round(float(lum[outer].mean()), 2) if outer.sum() > 8 else None,
            inner_lum=round(float(lum[inner].mean()), 2) if inner.sum() > 8 else None,
            delta=round(float(lum[outer].mean() - lum[inner].mean()), 2)
            if outer.sum() > 8 and inner.sum() > 8 else None)
    return out


def issue6_lash_blobs(run, cfg):
    """Connected components of each lash layer and their areas."""
    out = {}
    for side in SIDES:
        p = run.part(('step5', 'layers'), f'eyelash-{side}')
        if p is None:
            out[side] = dict(na=True)
            continue
        m = (p.img[..., 3] / 255.0) > 0.25
        n, lab, stats, cent = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
        comps = sorted((int(stats[i, cv2.CC_STAT_AREA]) for i in range(1, n)), reverse=True)
        out[side] = dict(components=len(comps), areas=comps,
                         total_pixels=int(m.sum()))
    return out


def issue7_hair_edge(run, orig, cfg):
    """Front-hair alpha staircase, and how well the silhouette reproduces the artwork's alpha."""
    p = run.part(('step4', 'layers'), 'front hair')
    out = {}
    if p is not None:
        out['front_hair'] = step4.alpha_edge_steps(p)
    back = run.part(('step4', 'layers'), 'back hair')
    if back is not None:
        out['back_hair'] = step4.alpha_edge_steps(back)
    flat = run.flattened()
    if flat is not None:
        oa = orig[..., 3] / 255.0
        fa = flat[..., 3] / 255.0
        band = (oa > 0.05) & (oa < 0.95)
        box = run.layer_box('front hair')
        if box and band.any():
            sel = np.zeros(band.shape, bool)
            sel[box[1]:box[3], box[0]:box[2]] = True
            sel &= band
            if sel.any():
                out['silhouette_alpha_front_hair_box'] = dict(
                    band_pixels=int(sel.sum()),
                    mean_abs_error=round(float(np.abs(fa - oa)[sel].mean()), 4))
        if band.any():
            err = np.abs(fa - oa)
            out['silhouette_alpha'] = dict(
                band_pixels=int(band.sum()),
                mean_abs_error=round(float(err[band].mean()), 4),
                over_025_pct=round(100.0 * float((err[band] > 0.25).mean()), 2),
                mean_alpha=round(float(fa[band].mean()), 4),
                mean_art_alpha=round(float(oa[band].mean()), 4))
    return out


def issue8_sclera(run, orig, cfg):
    """Sclera outside the artwork's opening, and iris pixels lost when the gaze goes up-right."""
    H, W = orig.shape[:2]
    out = {}
    size2, layers2 = run.posed_layers('p2')
    size0, layers0 = run.posed_layers('rest')
    for side in SIDES:
        opening, _ = opening_for(run, side, orig, H, W)
        if opening is None or layers2 is None:
            out[side] = dict(na=True)
            continue
        rec = {}
        for tag, layers, size in (('rest', layers0, size0), ('p2', layers2, size2)):
            if layers is None:
                continue
            scl = combined_alpha(layers, f'eyewhite-{side}', size)
            iris = combined_alpha(layers, f'irides-{side}', size)
            rec[tag] = dict(sclera_pixels=int((scl > 0.2).sum()),
                            sclera_outside_opening=int(((scl > 0.2) & (opening <= 0.1)).sum()),
                            iris_pixels=int((iris > 0.2).sum()))
        if 'rest' in rec and 'p2' in rec and rec['rest']['iris_pixels']:
            lost = rec['rest']['iris_pixels'] - rec['p2']['iris_pixels']
            rec['iris_clipped_pixels'] = int(lost)
            rec['iris_clipped_ratio'] = round(lost / rec['rest']['iris_pixels'], 4)
        rec['opening_pixels'] = int((opening > 0.5).sum())
        out[side] = rec
    return out


# -------------------------------------------------------------------- fix round 2

MOUTH_STATE_LAYERS = ('mouth', 'mouth close', 'mouth open', 'mouth small')


def mouth_roi(run, shape, pad=0.4):
    """Canvas box around the mouth: the union of this run's mouth layer boxes, padded."""
    H, W = shape[:2]
    boxes = [run.layer_box(n) for n in MOUTH_STATE_LAYERS]
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    px, py = int((x1 - x0) * pad), int((y1 - y0) * pad)
    return [max(x0 - px, 0), max(y0 - py, 0), min(x1 + px, W), min(y1 + py, H)]


def alpha_step_stats(mask):
    """|d alpha| between neighbouring pixels along the mask's soft edge."""
    band = (mask > 0.02) & (mask < 0.98)
    if int(band.sum()) < 20:
        return dict(edge_pixels=int(band.sum()), note='no soft edge')
    d = np.concatenate([np.abs(np.diff(mask, axis=1))[band[:, 1:] & band[:, :-1]],
                        np.abs(np.diff(mask, axis=0))[band[1:, :] & band[:-1, :]]])
    if not d.size:
        return dict(edge_pixels=int(band.sum()), adjacent_pairs=0)
    return dict(edge_pixels=int(band.sum()), adjacent_pairs=int(d.size),
                mean_abs_delta=round(float(d.mean()), 4),
                median_abs_delta=round(float(np.median(d)), 4),
                p95_abs_delta=round(float(np.percentile(d, 95)), 4),
                frac_gt_0_25=round(float((d > 0.25).mean()), 4),
                alpha_levels=int(len(np.unique(np.round(mask[band] * 255)))))


def issue9_mouth_mask(run, orig, cfg):
    """One smooth mask per run: edge jaggedness, component count per state, p4 against the artwork."""
    c6 = ((run.s6 or {}).get('variants') or {}).get('mouth') or {}
    mask = run.mouth_support()
    out = dict(mask_pixels=int((mask > 0.5).sum()),
               mask_alpha_gt_02=int((mask > 0.2).sum()),
               mask_bbox=[int(v) for v in cv2.boundingRect((mask > 0.02).astype(np.uint8))],
               declared_mask=(c6.get('mask') or None),
               edge=alpha_step_stats(mask))
    for name in MOUTH_STATE_LAYERS:
        p = run.variant_part(name)
        if p is None:
            continue
        m = (p.img[..., 3] / 255.0) > 0.5
        n, _lab, stats, _cent = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
        areas = sorted((int(stats[i, cv2.CC_STAT_AREA]) for i in range(1, n)), reverse=True)
        out[f'components_{name}'] = dict(components=len(areas), areas=areas[:6],
                                        pixels=int(m.sum()),
                                        bbox=[p.left, p.top, p.left + p.size[0], p.top + p.size[1]])
    asset_path = (cfg.get('assets') or {}).get('mouth_open')
    img = run.pose('p4')
    if asset_path and img is not None:
        asset = util.load_rgba(asset_path)
        gate = (asset[..., 3] > 128) & (mask > 0.5)
        d = np.abs(img[..., :3] - asset[..., :3]).mean(axis=2)
        out['p4_vs_mouth_open'] = dict(
            pixels=int(gate.sum()),
            mean_color_diff=round(float(d[gate].mean()), 2) if gate.any() else None,
            max_color_diff=round(float(d[gate].max()), 2) if gate.any() else None)
    return out


def issue10_mouth_states(run, orig, cfg):
    """Every mouth state: colour against its artwork, and how many mouth layers are visible at once."""
    r2 = cfg['compare']['round2']
    mask = run.mouth_support()
    thr = float(r2.get('visible_alpha', 0.2))
    out = dict(states={})
    for value, tag in r2['mouth_states']:
        img = run.pose(tag)
        if img is None:
            out['states'][value] = dict(pose=tag, na='pose not exported')
            continue
        key = (r2.get('mouth_asset_for_state') or {}).get(value)
        rec = dict(pose=tag, asset=key)
        if key == 'master':
            ref, gate = orig, (orig[..., 3] > 128)
        elif key and (cfg.get('assets') or {}).get(key):
            ref = util.load_rgba(cfg['assets'][key])
            gate = ref[..., 3] > 128
        else:
            ref, gate = None, None
        if ref is not None:
            d = np.abs(img[..., :3] - ref[..., :3]).mean(axis=2)
            sel = gate & (mask > 0.5) & (img[..., 3] > 128)
            rec['vs_artwork'] = dict(pixels=int(sel.sum()),
                                     mean_color_diff=round(float(d[sel].mean()), 2) if sel.any() else None,
                                     max_color_diff=round(float(d[sel].max()), 2) if sel.any() else None)
        size, layers = run.posed_layers(tag)
        if layers:
            visible = {}
            for name in MOUTH_STATE_LAYERS:
                a = combined_alpha(layers, name, size)
                n = int((a > thr).sum())
                if n:
                    visible[name] = n
            rec['visible_layers'] = visible
            rec['visible_count'] = len(visible)
        out['states'][value] = rec
    return out


def issue11_mouth_ring(run, orig, cfg):
    """At rest, the artwork's skin in the ring just outside the mouth mask."""
    r2 = cfg['compare']['round2']
    k = int(r2.get('mouth_ring_px', 10))
    mask = run.mouth_support()
    core = (mask > 0.5).astype(np.uint8)
    ring = (cv2.dilate(core, np.ones((2 * k + 1, 2 * k + 1), np.uint8)) > 0) & (core == 0)
    rest = run.pose('rest')
    out = dict(ring_px=k, ring_pixels=int(ring.sum()))
    if rest is None:
        out['na'] = 'no rest pose'
        return out
    d = np.abs(rest[..., :3] - orig[..., :3]).mean(axis=2)
    sel = ring & (orig[..., 3] > 200)
    out.update(mean_color_diff=round(float(d[sel].mean()), 2) if sel.any() else None,
               max_color_diff=round(float(d[sel].max()), 2) if sel.any() else None,
               rings_selected_pixels=int(sel.sum()))
    return out


def component_count(mask, min_area=1):
    n, _lab, stats, _c = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    return len([i for i in range(1, n) if int(stats[i, cv2.CC_STAT_AREA]) >= min_area])


def full_alpha(part, shape):
    out = np.zeros(shape[:2], np.float32)
    h, w = part.img.shape[:2]
    x0, y0 = max(part.left, 0), max(part.top, 0)
    x1, y1 = min(part.left + w, shape[1]), min(part.top + h, shape[0])
    if x1 > x0 and y1 > y0:
        out[y0:y1, x0:x1] = part.img[y0 - part.top:y1 - part.top,
                                     x0 - part.left:x1 - part.left, 3] / 255.0
    return out


def issue12_blue_dot(run, orig, cfg):
    """The coat's right edge: the artwork is transparent there, so any opaque model pixel shows."""
    r2 = cfg['compare']['round2']
    z = [int(v) for v in r2['blue_dot_zone']]
    flat = run.flattened()
    if flat is None:
        return dict(na='no flattened.png')
    x0, y0, x1, y1 = z
    d = np.abs(flat[..., :3] - orig[..., :3]).mean(axis=2)
    oa = orig[..., 3] / 255.0
    fa = flat[..., 3] / 255.0
    zone = np.zeros(d.shape, bool)
    zone[y0:y1, x0:x1] = True
    over_all = (fa > 0.5) & (oa < 0.2)
    over_zone = over_all & zone
    n, _lab, stats, _cent = cv2.connectedComponentsWithStats(over_zone.astype(np.uint8), 8)
    blobs = sorted(([int(stats[i, 0]), int(stats[i, 1]), int(stats[i, 2]), int(stats[i, 3]),
                     int(stats[i, 4])] for i in range(1, n)), key=lambda b: -b[4])
    offenders = {}
    for src in (run.s6 or {}).get('layers') or []:
        name = src['name']
        p = run.variant_part(name) or run.part(('step4', 'layers'), name)
        if p is None:
            continue
        a = full_alpha(p, d.shape)
        n_over = int(((a > 0.5) & (oa < 0.2)).sum())
        if n_over:
            offenders[name] = n_over
    return dict(zone=z,
                mean_color_diff=round(float(d[zone].mean()), 2),
                max_color_diff=round(float(d[zone].max()), 2),
                zone_pixels=int(zone.sum()),
                opaque_where_artwork_transparent_zone=int(over_zone.sum()),
                opaque_where_artwork_transparent_image=int(over_all.sum()),
                over_blobs_zone=blobs[:5],
                layers_opaque_outside_silhouette=dict(sorted(offenders.items(),
                                                             key=lambda kv: -kv[1])))


def issue13_gaze(run, orig, cfg):
    """Item 5: the iris stays inside the artwork's eyelid opening at every gaze; the ring is clean."""
    r2 = cfg['compare']['round2']
    H, W = orig.shape[:2]
    ring_px = int(r2.get('eye_ring_px', 3))
    dark_lum = float(r2.get('dark_lum', 80.0))
    out = dict(poses=list(r2.get('gaze_poses') or []), ring_px=ring_px, dark_lum=dark_lum, eyes={})
    for side in SIDES:
        opening, _box = opening_for(run, side, orig, H, W)
        if opening is None:
            continue
        core = (opening > 0.5).astype(np.uint8)
        ring = (cv2.dilate(core, np.ones((2 * ring_px + 1,) * 2, np.uint8)) > 0) & (core == 0)
        rec = dict(opening_pixels=int(core.sum()), ring_pixels=int(ring.sum()), poses={})
        for tag in out['poses']:
            size, layers = run.posed_layers(tag)
            img = run.pose(tag)
            if not layers or img is None:
                continue
            iris = combined_alpha(layers, f'irides-{side}', size)
            sclera = combined_alpha(layers, f'eyewhite-{side}', size)
            lum = cv2.cvtColor(np.clip(img[..., :3], 0, 255).astype(np.uint8),
                               cv2.COLOR_RGB2GRAY).astype(np.float32)
            rec['poses'][tag] = dict(
                iris_pixels=int((iris > 0.2).sum()),
                iris_outside_opening=int(((iris > 0.2) & (opening <= 0.1)).sum()),
                iris_outside_sclera=int(((iris > 0.2) & (sclera <= 0.2)).sum()),
                dark_pixels_ring=int(((lum < dark_lum) & ring).sum()),
                sclera_outside_opening=int(((sclera > 0.2) & (opening <= 0.1)).sum()))
        rec['max_iris_outside'] = max((v['iris_outside_opening'] for v in rec['poses'].values()),
                                      default=None)
        rec['mean_dark_ring'] = round(float(np.mean([v['dark_pixels_ring']
                                                    for v in rec['poses'].values()])), 1) \
            if rec['poses'] else None
        out['eyes'][side] = rec
    return out


def issue14_neck(run, orig, cfg):
    """Item 6: the neck is solid, reaches past the chin, and no gap shows between chin and collar."""
    r2 = cfg['compare']['round2']
    H, W = orig.shape[:2]
    layers6 = {l['name']: l for l in ((run.s6 or {}).get('layers') or [])}
    face = layers6.get('face') or {}
    face_bottom = int(face.get('top', 0) + face.get('height', 0))
    out = dict(face_bottom=face_bottom, poses={})
    size, layers = run.posed_layers('rest')
    if layers:
        neck = combined_alpha(layers, 'neck', size)
        ys, xs = np.where(neck > 0.5)
        out['rest'] = dict(
            neck_pixels=int((neck > 0.5).sum()),
            neck_bbox=[int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
            if len(ys) else None,
            below_face_bottom_px=int(int(ys.max()) + 1 - face_bottom) if len(ys) else None,
            above_face_bottom_px=int(face_bottom - int(ys.min())) if len(ys) else None)
    # the artwork's own neck skin under the chin: the only place a hole means "see-through neck"
    band_mask = None
    if face:
        y0 = max(face_bottom - 4, 0)
        y1 = min(face_bottom + 90, H)
        x0 = max(int(face.get('left', 0)), 0)
        x1 = min(int(face.get('left', 0) + face.get('width', 0)), W)
        rgb = orig[..., :3]
        a = orig[..., 3] / 255.0
        mxx = rgb.max(axis=2)
        mnn = rgb.min(axis=2)
        chroma = (mxx - mnn) / np.maximum(mxx, 1.0)
        warm = (rgb[..., 0] >= rgb[..., 1]) & (rgb[..., 1] >= rgb[..., 2])
        skin = (a > 0.9) & (chroma > 0.05) & (chroma < 0.22) & warm & (mxx > 90)
        band_mask = np.zeros((H, W), bool)
        band_mask[y0:y1, x0:x1] = skin[y0:y1, x0:x1]
        nd = int((((cfg.get('step8_export') or {}).get('neck') or {}).get('band') or {}).get('dilate_px', 1))
        if nd > 0:
            band_mask = cv2.dilate(band_mask.astype(np.uint8),
                                   np.ones((2 * nd + 1,) * 2, np.uint8)) > 0
        out['band_rect'] = [int(x0), int(y0), int(x1), int(y1)]
        out['band_pixels'] = int(band_mask.sum())
    for tag in ['rest'] + list(r2.get('neck_poses') or []):
        img = run.pose(tag)
        if img is None:
            continue
        rec = out['poses'].setdefault(tag, {})
        if band_mask is not None:
            alpha = img[..., 3] / 255.0
            rec['band_pixels'] = int(band_mask.sum())
            rec['band_transparent_pixels'] = int(((alpha <= 0.5) & band_mask).sum())
        size_p, layers_p = run.posed_layers(tag)
        if layers_p:
            neck = combined_alpha(layers_p, 'neck', size_p)
            rec['neck_pixels'] = int((neck > 0.5).sum())
    return out


def issue15_residue(run, orig, cfg):
    """Item 7: one earring only, and no second mouth hidden in face / ears / hair.

    Measured under the earring's own silhouette: the carrier that betrays a baked-in copy is the
    hair, which is dark (~60-80) while the earring is bright (~150). A second copy therefore shows
    up as bright pixels there plus a positive correlation with the earring's pattern.
    """
    r2 = cfg['compare']['round2']
    H, W = orig.shape[:2]
    out = dict(references={}, layers={})
    tol = 34.0
    ref_part = run.part(('step6', 'layers'), 'earwear') or run.part(('step4', 'layers'), 'earwear')
    if ref_part is None:
        out['na'] = 'no earwear layer'
        return out
    a = ref_part.img[..., 3] / 255.0
    if not (a > 0.5).any():
        out['na'] = 'earwear has no pixels'
        return out
    ref_rgb = np.median(ref_part.img[a > 0.5][:, :3], axis=0)
    box = [ref_part.left, ref_part.top,
           ref_part.left + ref_part.size[0], ref_part.top + ref_part.size[1]]
    core = cv2.erode((a > 0.5).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    out['references']['earwear'] = dict(colour=[round(float(v), 1) for v in ref_rgb], box=box,
                                        pixels=int((a > 0.5).sum()),
                                        components=component_count(a > 0.5))
    fp = np.zeros((H, W), bool)
    fp[ref_part.top:ref_part.top + ref_part.size[1],
       ref_part.left:ref_part.left + ref_part.size[0]] = core
    out['footprint'] = dict(pixels=int(fp.sum()), layers={})
    ear_rgb = np.zeros((H, W, 3), np.float32)
    ear_rgb[ref_part.top:ref_part.top + ref_part.size[1],
            ref_part.left:ref_part.left + ref_part.size[0]] = ref_part.img[..., :3]
    for name in ('face', 'ears', 'front hair', 'back hair'):
        p = run.part(('step6', 'layers'), name) or run.part(('step4', 'layers'), name)
        if p is None:
            continue
        img = np.zeros((H, W, 4), np.float32)
        img[p.top:p.top + p.size[1], p.left:p.left + p.size[0]] = p.img
        sel = fp & (img[..., 3] > 128)
        rec = dict(opaque=int(sel.sum()), colour_match_pixels=0)
        h, w = p.img.shape[:2]
        x0, x1 = max(box[0] - 4 - p.left, 0), min(box[2] + 4 - p.left, w)
        y0, y1 = max(box[1] - 4 - p.top, 0), min(box[3] + 4 - p.top, h)
        if x1 > x0 and y1 > y0:
            sub = p.img[y0:y1, x0:x1]
            d = np.abs(sub[..., :3] - ref_rgb).mean(axis=2)
            rec['colour_match_pixels'] = int(((d < tol) & (sub[..., 3] > 128)).sum())
        if sel.any():
            rec['bright_pixels'] = int((sel & (img[..., :3].max(axis=2) > 120)).sum())
            rec['mean_colour'] = [round(float(v), 1) for v in img[..., :3][sel].mean(axis=0)]
            va = ear_rgb[sel] - ear_rgb[sel].mean(axis=0)
            vb = img[..., :3][sel] - img[..., :3][sel].mean(axis=0)
            den = np.sqrt((va ** 2).sum()) * np.sqrt((vb ** 2).sum())
            rec['ncc_vs_earring'] = round(float((va * vb).sum() / den), 3) if den > 0 else None
        out['layers'][name] = rec
        out['footprint']['layers'][name] = rec
    hair = [k for k in out['footprint']['layers'] if 'hair' in k]
    out['hair_copy_pixels'] = max((out['footprint']['layers'][k].get('bright_pixels', 0)
                                   for k in hair), default=0)
    out['hair_copy_limit'] = int((r2.get('accessory') or {}).get('hair_bright_max', 30))
    out['hair_copy_pass'] = out['hair_copy_pixels'] <= out['hair_copy_limit']
    out['total_earring_residue'] = int(sum(v.get('colour_match_pixels', 0)
                                          for v in out['layers'].values()))
    mask = run.mouth_support()
    face = run.part(('step6', 'layers'), 'face') or run.part(('step4', 'layers'), 'face')
    if face is not None and mask is not None:
        h, w = face.img.shape[:2]
        m = mask[face.top:face.top + h, face.left:face.left + w]
        lum = face.img[..., :3].mean(axis=2)
        dark = (m > 0.5) & (face.img[..., 3] > 128) & (lum < 90)
        out['layers'].setdefault('face', {})['mouth_line_pixels'] = int(dark.sum())
    out['total_mouth_residue'] = int(sum(v.get('mouth_line_pixels', 0)
                                        for v in out['layers'].values()))
    return out



def issue16_strength(run, orig, cfg):
    """Item 8: what psd2live's head-turn strength does to the ±30° / +30° poses."""
    hs = ((run.s8 or {}).get('head_strength') or {})
    out = dict(variants={}, diff=hs.get('diff') or {}, poses=hs.get('poses') or {})
    for label, rec in (hs.get('variants') or {}).items():
        out['variants'][label] = dict(head_strength=rec.get('head_strength'),
                                      poses=sorted((rec.get('poses') or {}).keys()))
    return out


def export_baseline_poses(cfg, run, tags, cache_dir, log=print):
    """Export poses an older baseline never wrote, from its own native.psd, into the new run.

    run3 predates the gaze and neck poses. Re-exporting them from its committed PSD with the same
    CLI target run3 used keeps run3 untouched and still compares like with like.
    """
    need = [t for t in tags if run.pose(t) is None and not (run.extra_poses or {}).get(t)]
    if not need:
        return {}
    psd = os.path.join(run.root, 'step6', 'native.psd')
    if not os.path.exists(psd):
        return {}
    env = dict(os.environ)
    env['JAVA_HOME'] = cfg['env']['java_home']
    poses = (cfg['compare']['round2'].get('extra_poses') or {})
    stopped = False
    for tag in need:
        d = os.path.join(cache_dir, tag)
        if os.path.exists(os.path.join(d, f'pose_{tag}.png')) and glob.glob(os.path.join(d, '*.psd')):
            # a previous run already exported this pose; each export costs a JVM + Compose launch
            run.extra_poses[tag] = d
            log(f'compare: reusing cached baseline pose {run.name}/{tag} in {d}')
            continue
        os.makedirs(d, exist_ok=True)
        args = f'export {psd} --target psd-pose'
        if poses.get(tag):
            args += f' --set pose={poses[tag]}'
        args += f' --output {d}'
        log(f'compare: baseline {run.name} has no pose {tag}; exporting it into {d}')
        proc = subprocess.run(['./gradlew', 'run', '-q', f'--args={args}'],
                              cwd=cfg['env']['psd2live_dir'], env=env,
                              capture_output=True, text=True, timeout=1800)
        if proc.returncode != 0:
            log(f'compare: pose {tag} export failed ({proc.returncode})')
            continue
        run.extra_poses[tag] = d
        psds = sorted(glob.glob(os.path.join(d, '*.psd')))
        if psds:
            size, parts = step8_load(psds[0])
            util.save_rgba(util.composite(parts, size), os.path.join(d, f'pose_{tag}.png'))
        stopped = True
    if stopped:
        subprocess.run(['./gradlew', '--stop'], cwd=cfg['env']['psd2live_dir'], env=env,
                       capture_output=True, timeout=180)
    return run.extra_poses


def step8_load(path):
    from psd_tools import PSDImage
    psd = PSDImage.open(path)
    layers = [util.Part(l.name, util.layer_rgba(l), l.bbox[0], l.bbox[1])
              for l in psd.descendants() if l.kind == 'pixel']
    return psd.size, layers


# -------------------------------------------------------------------- figures

def _crop_rgb(img, box, z=3, checker=True):
    x0, y0, x1, y1 = box
    x0, y0 = max(int(x0), 0), max(int(y0), 0)
    x1, y1 = max(min(int(x1), img.shape[1]), x0 + 1), max(min(int(y1), img.shape[0]), y0 + 1)
    sub = img[y0:y1, x0:x1]
    if sub.ndim == 2:
        sub = np.repeat(sub[..., None], 3, axis=2)
    rgb = util.on_checker(sub) if (checker and sub.shape[2] == 4) else sub[..., :3]
    return cv2.resize(rgb, (rgb.shape[1] * z, rgb.shape[0] * z), interpolation=cv2.INTER_NEAREST)


def _figure(pairs, out_path, cols, cell):
    """pairs: list of (label, rgb tile)."""
    tiles = [p[1] for p in pairs]
    labels = [p[0] for p in pairs]
    util.montage(tiles, cols=cols, cell=cell, labels=labels).save(out_path)


def build(cfg, out_root, log=print):
    out = os.path.join(out_root, 'compare')
    os.makedirs(out, exist_ok=True)
    c = cfg['compare']
    base = Run(c['baseline_dir']) if os.path.isdir(c['baseline_dir']) else None
    new = Run(out_root)
    orig = util.load_rgba(cfg['input']['original_png'])
    assets = cfg.get('assets') or {}
    runs = [r for r in (base, new) if r is not None]
    z = int(c.get('crop_zoom', 3))

    results = {}
    for issue, fn in (('1_holes', issue1_holes), ('2_hair_strip', issue2_hair_strip),
                      ('7_hair_edge', issue7_hair_edge)):
        results[issue] = {r.name: fn(r, orig, cfg) for r in runs}
    for issue, fn in (('3_closed_eye', issue3_closed_eye), ('4_mouth', issue4_mouth)):
        results[issue] = {r.name: fn(r, orig, cfg, assets) for r in runs}
    results['6_lash_blobs'] = {r.name: issue6_lash_blobs(r, cfg) for r in runs}
    results['5_iris_rim'] = {r.name: issue5_iris_rim(r, orig, cfg) for r in runs}
    results['8_sclera'] = {r.name: issue8_sclera(r, orig, cfg) for r in runs}
    for issue, fn in (('9_mouth_mask', issue9_mouth_mask), ('10_mouth_states', issue10_mouth_states),
                      ('11_mouth_ring', issue11_mouth_ring), ('12_blue_dot', issue12_blue_dot)):
        results[issue] = {r.name: fn(r, orig, cfg) for r in runs}
    # poses an older baseline never exported (gaze, neck) are exported from its own PSD here
    r2 = c.get('round2') or {}
    need = list(r2.get('gaze_poses') or []) + list(r2.get('neck_poses') or [])
    for r in runs:
        export_baseline_poses(cfg, r, need, os.path.join(out, 'baseline_poses', r.name), log=log)
    for issue, fn in (('13_gaze', issue13_gaze), ('14_neck', issue14_neck),
                      ('15_residue', issue15_residue)):
        results[issue] = {r.name: fn(r, orig, cfg) for r in runs}
    results['16_strength'] = {r.name: issue16_strength(r, orig, cfg) for r in runs}

    # ---- figures ------------------------------------------------------------
    figs = {}

    def save(name, pairs, cols, cell):
        path = os.path.join(out, name)
        _figure(pairs, path, cols, cell)
        figs[name] = path

    # 1: the chin/collar zone, with interior holes marked
    pairs = []
    for r in runs:
        flat = r.flattened()
        info = results['1_holes'][r.name]
        zone = (info.get('chin_collar_band') or {}).get('zone') or [330, 540, 700, 700]
        if flat is None:
            continue
        oa = orig[..., 3] / 255.0
        fa = flat[..., 3] / 255.0
        enc = repair.interior_transparency(fa)
        holes = (oa > 0.5) & (fa < 0.5) & enc
        vis = flat.copy()
        vis[holes] = np.array([255, 0, 0, 255], np.float32)
        pairs.append((f'{r.name}: interior holes {int(holes.sum())}px',
                      _crop_rgb(vis, zone, z)))
    pairs.append(('original (same zone)', _crop_rgb(orig, zone, z)))
    cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
    save('check_cmp1_holes.png', pairs, 1, cell)

    # 2: the hair strip on the character's right
    b = new.layer_box('front hair') or base.layer_box('front hair')
    strip = [590, 120, 720, 380]
    pairs = [('original (strip zone)', _crop_rgb(orig, strip, z))]
    for r in runs:
        flat = r.flattened()
        if flat is not None:
            pairs.append((f'{r.name}: flatten', _crop_rgb(flat, strip, z)))
    cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
    save('check_cmp2_hair_strip.png', pairs, 1 + len(pairs) // 3, cell)

    # 3: closed eye against the artist's lid
    pairs = []
    eye_roi = None
    for r in runs:
        info = results['3_closed_eye'][r.name]
        side = 'l' if isinstance(info.get('l'), dict) and 'roi' in info.get('l', {}) else 'r'
        rec = info.get(side) or {}
        eye_roi = rec.get('roi') or eye_roi
        if not eye_roi:
            continue
        pairs.append((f'{r.name}: closed iris px {rec.get("closed_iris_pixels")}',
                      _crop_rgb(r.pose(rec['pose']), eye_roi, z)))
    if assets.get('eye_close') and eye_roi:
        pairs.append(('artist eyelid_closed', _crop_rgb(util.load_rgba(assets['eye_close']),
                                                        eye_roi, z)))
    if pairs:
        cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
        save('check_cmp3_closed_eye.png', pairs, 1, cell)

    # 4: mouth shut / open / half
    roi = (results['4_mouth'].get(new.name) or {}).get('roi') or \
        (results['4_mouth'].get(base.name) if base else {}).get('roi')
    pairs = []
    for r in runs:
        for tag in ('rest', 'p4', 'p7'):
            img = r.pose(tag)
            if img is None or not roi:
                continue
            pairs.append((f'{r.name} {tag}', _crop_rgb(img, roi, z)))
    for key in ('mouth_open', 'mouth_small'):
        if assets.get(key) and roi:
            pairs.append((f'artist {key}', _crop_rgb(util.load_rgba(assets[key]), roi, z)))
    if pairs:
        cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
        save('check_cmp4_mouth.png', pairs, 3, cell)

    # 5: iris rim at 6x
    pairs = []
    for r in runs:
        eye = ((r.s5 or {}).get('eyes') or {}).get('l')
        p = r.part(('step5', 'layers'), 'irides-l')
        if p is None or not eye:
            continue
        cx, cy = eye['center'][0], eye['center'][1]
        rr = eye['radius'] * 1.35
        box = [p.left + cx - rr, p.top + cy - rr, p.left + cx + rr, p.top + cy + rr]
        pairs.append((f'{r.name}: rim delta {results["5_iris_rim"][r.name]["l"]["delta"]}',
                      _crop_rgb(p.img, [box[0] - p.left, box[1] - p.top,
                                        box[2] - p.left, box[3] - p.top], 6)))
    if pairs:
        cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
        save('check_cmp5_iris_rim.png', pairs, len(pairs), cell)

    # 6: lash layers at 4x
    pairs = []
    eye = (new.s5 or {}).get('eyes', {}).get('l') or (base.s5 or {}).get('eyes', {}).get('l')
    for r in runs:
        p = r.part(('step5', 'layers'), 'eyelash-l')
        if p is None or not eye:
            continue
        cx, cy = eye['center'][0], eye['center'][1]
        rr = eye['radius'] * 2.2
        pairs.append((f'{r.name}: lash blobs {results["6_lash_blobs"][r.name]["l"]["components"]}',
                      _crop_rgb(p.img, [cx - rr, cy - rr, cx + rr, cy + rr], 4)))
    if pairs:
        cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
        save('check_cmp6_lash_blobs.png', pairs, len(pairs), cell)

    # 7: front hair edge at 5x, plus the alpha profile
    box = [170, 250, 300, 400]
    pairs = []
    for r in runs:
        p = r.part(('step4', 'layers'), 'front hair')
        if p is None:
            continue
        canvas = util.composite([p], (orig.shape[1], orig.shape[0]))
        tile = _crop_rgb(canvas, box, 5)
        alpha = canvas[box[1]:box[3], box[0]:box[2], 3:4] / 255.0
        stamp = np.repeat(alpha, 3, axis=2)
        stamp = np.clip(stamp * 255.0, 0, 255).astype(np.float32)
        stamp = cv2.resize(stamp, (tile.shape[1], tile.shape[0]), interpolation=cv2.INTER_NEAREST)
        pairs.append((f'{r.name}: front hair, alpha below',
                      np.concatenate([tile, stamp], axis=1)))
    if pairs:
        cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
        save('check_cmp7_hair_edge.png', pairs, 1, cell)

    # 8: gaze up-right, iris vs the artwork opening
    pairs = []
    for r in runs:
        img = r.pose('p2')
        if img is None:
            continue
        eye = ((r.s5 or {}).get('eyes') or {}).get('l')
        if not eye:
            continue
        cx, cy = eye['center_native']
        rr = max(eye['ellipse']['rx'], eye['ellipse']['ry']) * 1.6
        info = results['8_sclera'][r.name].get('l') or {}
        pairs.append((f'{r.name}: clipped {info.get("iris_clipped_pixels")}px '
                      f'({info.get("iris_clipped_ratio")})',
                      _crop_rgb(img, [cx - rr, cy - rr, cx + rr, cy + rr], z)))
    if pairs:
        cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
        save('check_cmp8_sclera.png', pairs, len(pairs), cell)

    # ---- fix round 2: the mouth's five states, the blue dot, the regression strip ----
    r2 = c.get('round2') or {}
    boxes = [b for b in (mouth_roi(r, orig.shape) for r in runs) if b]
    roi = ([min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)] if boxes else None)
    results['mouth_roi'] = roi
    if roi and r2.get('mouth_states'):
        pairs = []
        for value, tag in r2['mouth_states']:
            for r in runs:
                img = r.pose(tag)
                if img is None:
                    continue
                info = ((results['10_mouth_states'][r.name].get('states') or {}).get(value)) or {}
                d = (info.get('vs_artwork') or {}).get('mean_color_diff')
                pairs.append((f'{r.name} ParamMouthOpenY={value} ({tag})  '
                              f'diff {d}  visible {info.get("visible_count")}',
                              _crop_rgb(img, roi, z)))
        for key in ('mouth_small', 'mouth_open'):
            if (assets or {}).get(key):
                pairs.append((f'artist {key}', _crop_rgb(util.load_rgba(assets[key]), roi, z)))
        if pairs:
            cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
            save('check_cmp_mouth5.png', pairs, max(len(runs), 1), cell)

    zp = r2.get('blue_dot_zone')
    if zp:
        pairs = [('original artwork', _crop_rgb(orig, zp, 6))]
        for r in runs:
            flat = r.flattened()
            if flat is None:
                continue
            info = results['12_blue_dot'][r.name]
            pairs.append((f'{r.name}: max diff {info.get("max_color_diff")}, '
                          f'opaque-outside {info.get("opaque_where_artwork_transparent_zone")}px',
                          _crop_rgb(flat, zp, 6)))
        if pairs:
            cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
            save('check_cmp_blue_dot.png', pairs, len(pairs), cell)

    reg_pose = {'closed_eye_left': 'p1', 'closed_eye_right': 'p3',
                'neck_chin': 'rest', 'front_hair': 'rest'}
    pairs = []
    for label, box in (r2.get('regression_boxes') or {}).items():
        for r in runs:
            img = r.pose(reg_pose.get(label, 'rest'))
            if img is None:
                continue
            pairs.append((f'{label} {r.name}', _crop_rgb(img, box, z)))
    if pairs:
        cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
        save('check_cmp_regression.png', pairs, max(len(runs), 1), cell)

    # ---- items 5-8 figures --------------------------------------------------
    def eye_box(run, side, pad=1.8):
        eye = ((run.s5 or {}).get('eyes') or {}).get(side)
        if not eye:
            return None
        cx, cy = eye['center_native']
        rr = max(eye['ellipse']['rx'], eye['ellipse']['ry']) * pad
        return [cx - rr, cy - rr, cx + rr, cy + rr]

    gaze_rows = [('g_down', 'down'), ('g_up', 'up'), ('g_left', 'left'), ('g_right', 'right')]
    pairs = []
    for tag, label in gaze_rows:
        for r in runs:
            box = eye_box(r, 'l')
            img = r.pose(tag)
            if img is None or not box:
                continue
            info = ((results['13_gaze'][r.name].get('eyes') or {}).get('l') or {}).get('poses', {}).get(tag, {})
            pairs.append((f'{label} {r.name}: iris outside {info.get("iris_outside_opening")}px, '
                          f'dark ring {info.get("dark_pixels_ring")}px',
                          _crop_rgb(img, box, z + 1)))
    if pairs:
        cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
        save('check_cmp_gaze.png', pairs, len(runs), cell)

    pairs = []
    for tag in ['rest'] + list(r2.get('neck_poses') or []):
        for r in runs:
            rec = (results['14_neck'][r.name].get('poses') or {}).get(tag) or {}
            box = results['14_neck'][r.name].get('band_rect')
            img = r.pose(tag)
            if img is None or not box:
                continue
            x0, y0, x1, y1 = box
            pad = 20
            box2 = [x0 - pad, y0 - pad, x1 + pad, y1 + pad]
            pairs.append((f'{tag} {r.name}: band transparent {rec.get("band_transparent_pixels")}px, '
                          f'neck {rec.get("neck_pixels")}px', _crop_rgb(img, box2, z)))
    if pairs:
        cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
        save('check_cmp_neck.png', pairs, len(runs), cell)

    pairs = []
    boxes = (r2.get('earring_boxes') or {})
    ebox = boxes.get('left') or [440, 300, 520, 420]
    for tag in list(r2.get('accessory_poses') or ['p5', 'p6']):
        for r in runs:
            img = r.pose(tag)
            if img is None:
                continue
            info = (results['15_residue'][r.name] or {})
            pairs.append((f'{tag} {r.name}: earring-colour residue {info.get("total_earring_residue")}px, '
                          f'mouth-line residue {info.get("total_mouth_residue")}px',
                          _crop_rgb(img, ebox, z + 1)))
    if pairs:
        cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
        save('check_cmp_earring.png', pairs, len(runs), cell)

    strength = ((new.s8 or {}).get('head_strength') or {})
    if strength.get('variants'):
        pairs = []
        for tag, pose in (strength.get('poses') or {}).items():
            for label in strength['variants']:
                p = os.path.join(new.root, 'step8', f'pose_hs_{label}_{tag}.png')
                if not os.path.exists(p):
                    continue
                img = util.load_rgba(p)
                bb = (new.layer_box('face') or [300, 300, 700, 700])
                pad = 40
                box = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad]
                value = strength['variants'][label].get('head_strength')
                pairs.append((f'{tag} head-strength {value} ({label})', _crop_rgb(img, box, z)))
            imgs = {}
            for label in strength['variants']:
                p = os.path.join(new.root, 'step8', f'pose_hs_{label}_{tag}.png')
                if os.path.exists(p):
                    imgs[label] = util.load_rgba(p)
            if len(imgs) >= 2:
                labels = sorted(imgs)
                a, b = imgs[labels[0]], imgs[labels[1]]
                heat = util.diff_heatmap(a, b, None, 3.0)
                bb = (new.layer_box('face') or [300, 300, 700, 700])
                pad = 40
                box = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad]
                pairs.append((f'{tag}: difference {labels[0]} vs {labels[1]}',
                              _crop_rgb(heat, box, z)))
        if pairs:
            cell = (pairs[0][1].shape[1], pairs[0][1].shape[0])
            save('check_cmp_head_strength.png', pairs, len(strength['variants']) + 1, cell)

    metrics = dict(step='compare', baseline=base.name if base else None, current=new.name,
                   issues=results, figures=sorted(figs))
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    log(f'compare: {len(figs)} figures -> {out}')
    return metrics


def run(cfg, out_root, log=print):
    return build(cfg, out_root, log=log)
