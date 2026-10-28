"""Reference-pack overrides - fold docs/live2d-ref-pack.md edits into the layer stack.

M1's hidden or broken parts (the eyelid strokes under the face, the neck behind the headphones,
the eyeballs, the headphone inner cups, the earring junction) were redrawn by GPT-Image as a
"reference pack": full-frame edits at (almost) M1's size, one material per file. This step registers
each edit onto M1, cuts the target region out and folds it into the matching layer before step6
assembles the PSD, so psd2live rigs the corrected pixels instead of the See-through/segly guess.

Registration is the same two-stage idea as tools/spike-align: SIFT on the silhouette, RANSAC
similarity (translation + rotation + uniform scale), least squares refinement on the inliers.
"""
import os

import cv2
import numpy as np

from . import util

SIFT_FEATURES = 4000
SIFT_CONTRAST = 0.008
RATIO = 0.75
RANSAC_PX = 3.0
MIN_INLIERS = 12


# --------------------------------------------------------------------- registration

def _gray_gate(rgba, alpha_gate=64):
    a = (rgba[..., 3] >= alpha_gate).astype(np.uint8) * 255
    g = cv2.cvtColor(np.clip(rgba[..., :3], 0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
    return g, a


def align(ref, master):
    """Similarity transform ref -> master (2x3 float), from SIFT matches on the silhouettes.

    Returns (None, stats) when there are too few trustworthy matches, so the caller can report it
    instead of warping with garbage.
    """
    sift = cv2.SIFT_create(nfeatures=SIFT_FEATURES, contrastThreshold=SIFT_CONTRAST)
    gm, am = _gray_gate(master)
    gr, ar = _gray_gate(ref)
    km, dm = sift.detectAndCompute(gm, am)
    kr, dr = sift.detectAndCompute(gr, ar)
    if dm is None or dr is None or len(dm) < 4 or len(dr) < 4:
        return None, {'error': 'not enough features'}
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(dr, dm, k=2)
    good = [p for p, q in pairs if p.distance < RATIO * q.distance]
    if len(good) < MIN_INLIERS:
        return None, {'error': f'only {len(good)} good matches'}
    src = np.float32([kr[g.queryIdx].pt for g in good])
    dst = np.float32([km[g.trainIdx].pt for g in good])
    H, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC,
                                         ransacReprojThreshold=RANSAC_PX,
                                         maxIters=20000, confidence=0.999)
    if H is None or inl is None:
        return None, {'error': 'RANSAC failed'}
    inl = inl.ravel().astype(bool)
    if int(inl.sum()) < MIN_INLIERS:
        return None, {'error': f'only {int(inl.sum())} inliers'}
    # least-squares refinement on the inliers (the RANSAC estimate is a coarse consensus)
    A = np.zeros((2 * int(inl.sum()), 4), np.float64)
    b = np.zeros(2 * int(inl.sum()), np.float64)
    s, d = np.float64(src[inl]), np.float64(dst[inl])
    A[0::2, 0] = s[:, 0]
    A[0::2, 1] = -s[:, 1]
    A[0::2, 2] = 1.0
    A[1::2, 0] = s[:, 1]
    A[1::2, 1] = s[:, 0]
    A[1::2, 3] = 1.0
    b[0::2] = d[:, 0]
    b[1::2] = d[:, 1]
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    a, bb, tx, ty = sol
    H = np.array([[a, -bb, tx], [bb, a, ty]], np.float64)
    proj = s @ H[:, :2].T + H[:, 2]
    reproj = float(np.sqrt(((proj - d) ** 2).sum(axis=1).mean()))
    scale = float(np.hypot(H[0, 0], H[1, 0]))
    rot = float(np.degrees(np.arctan2(H[1, 0], H[0, 0])))
    return H, {'inliers': int(inl.sum()), 'good': len(good),
               'scale': round(scale, 5), 'rotation_deg': round(rot, 4),
               'translation': [round(float(tx), 2), round(float(ty), 2)],
               'reproj_px': round(reproj, 3)}


def _warp(ref, H, size):
    """Warp an RGBA edit onto the master canvas; outside stays transparent."""
    w, h = size
    return cv2.warpAffine(np.ascontiguousarray(ref, np.float32), H, (w, h),
                          flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                          borderValue=(0, 0, 0, 0))


# --------------------------------------------------------------------- masks

def _box_mask(shape, box):
    h, w = shape
    m = np.zeros((h, w), np.float32)
    x0, y0, x1, y1 = (int(v) for v in box)
    m[max(y0, 0):min(y1, h), max(x0, 0):min(x1, w)] = 1.0
    return m


def _disc_mask(shape, cx, cy, r):
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w]
    return ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r).astype(np.float32)


def target_alpha_canvas(parts, names, size):
    """Union of the named layers' alpha, on the master canvas (0..1)."""
    w, h = size
    cov = np.zeros((h, w), np.float32)
    for n in names:
        p = parts.get(n)
        if p is None:
            continue
        a = p.img[..., 3] / 255.0
        ph, pw = a.shape
        x0, y0 = max(p.left, 0), max(p.top, 0)
        x1, y1 = min(p.left + pw, w), min(p.top + ph, h)
        if x1 <= x0 or y1 <= y0:
            continue
        sub = a[y0 - p.top:y1 - p.top, x0 - p.left:x1 - p.left]
        np.maximum(cov[y0:y1, x0:x1], sub, out=cov[y0:y1, x0:x1])
    return cov


def _above_coverage(parts, order, target_names, size):
    """Union alpha of the layers stacked strictly above the targets (0..1), or None."""
    idx = [order.index(n) for n in target_names if n in order]
    if not idx:
        return None
    above = order[max(idx) + 1:]
    if not above:
        return np.zeros((size[1], size[0]), np.float32)
    return target_alpha_canvas(parts, above, size)


def build_mask(item, ref_w, orig, parts, size, order=None):
    """0..1 mask for one override.

    box -> clamp to target -> hidden-only (occluded by the layers above) -> diff gate ->
    dilate -> feather. `size` follows util's (w, h) convention.
    """
    w, h = size
    m = _box_mask((h, w), item['box']) if item.get('box') else np.ones((h, w), np.float32)
    if item.get('hidden_only') and order:
        cov = _above_coverage(parts, order, item.get('target_names') or [], (w, h))
        if cov is not None:
            hid = (cov > 0.5).astype(np.uint8)
            d = int(item.get('hidden_dilate_px', 2))
            if d > 0:
                hid = cv2.dilate(hid, np.ones((2 * d + 1, 2 * d + 1), np.uint8))
            m = m * hid.astype(np.float32)
    if item.get('clamp_to_target'):
        ta = target_alpha_canvas(parts, item.get('target_names') or [], (w, h))
        d = int(item.get('clamp_dilate_px', 0))
        if d > 0:
            ta = cv2.dilate((ta > 0.5).astype(np.uint8),
                            np.ones((2 * d + 1, 2 * d + 1), np.uint8)).astype(np.float32)
        m = m * (ta > 0.5)
    if item.get('mode', 'full') == 'diff':
        de = np.abs(ref_w[..., :3] - orig[..., :3]).mean(axis=2)
        m = m * (de > float(item.get('threshold', 20.0)))
    d = int(item.get('dilate_px', 0))
    if d > 0:
        m = cv2.dilate((m > 0.5).astype(np.uint8),
                       np.ones((2 * d + 1, 2 * d + 1), np.uint8)).astype(np.float32)
    f = float(item.get('feather_px', 0.0))
    if f > 0:
        m = cv2.GaussianBlur(m, (0, 0), f)
    return np.clip(m, 0.0, 1.0)


# --------------------------------------------------------------------- fold

def _to_canvas(part, size):
    w, h = size
    c = np.zeros((h, w, 4), np.float32)
    ph, pw = part.img.shape[:2]
    c[part.top:part.top + ph, part.left:part.left + pw] = part.img
    return c


def _from_canvas(name, canvas):
    a = canvas[..., 3]
    ys, xs = np.where(a > 0)
    if len(xs) == 0:
        return util.Part(name, np.zeros((1, 1, 4), np.float32), 0, 0)
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    return util.Part(name, canvas[y0:y1, x0:x1], x0, y0)


def _fold(part, ref_w, mask, alpha_mode):
    """Overlay ref_w on `part` inside `mask`; grow the alpha or keep the existing coverage."""
    canvas = _to_canvas(part, ref_w.shape[1::-1])
    m = mask[..., None]
    rgb = ref_w[..., :3]
    canvas[..., :3] = rgb * m + canvas[..., :3] * (1 - m)
    if alpha_mode == 'grow':
        canvas[..., 3] = np.maximum(canvas[..., 3], mask * 255.0)
    return canvas


def apply(cfg, parts, orig, out_root, order=None, log=print):
    """Fold every enabled override into `parts` (in place) and return (parts, metrics)."""
    ov = cfg.get('overrides') or {}
    if not ov.get('enabled'):
        return parts, {'enabled': False}
    out = os.path.join(out_root, 'overrides')
    os.makedirs(out, exist_ok=True)
    H, W = orig.shape[:2]
    items_metrics = []

    for item in ov['items']:
        iid = item['id']
        path = os.path.join(ov['dir'], item['file'])
        if not os.path.exists(path):
            items_metrics.append({'id': iid, 'registered': False, 'error': 'file missing'})
            log(f'  override {iid}: 文件不存在 {path}')
            continue
        ref = util.load_rgba(path)
        Hm, st = align(ref, orig)
        if Hm is None:
            items_metrics.append({'id': iid, 'registered': False, 'error': st.get('error')})
            log(f'  override {iid}: 配准失败 ({st.get("error")})')
            continue
        ref_w = _warp(ref, Hm, (W, H))

        # targets: either one list (same mask) or a per-side split about the midline
        if item.get('split'):
            mid = float(item['split']['midline'])
            yy, xx = np.mgrid[0:H, 0:W]
            side = {'l': (xx >= mid).astype(np.float32), 'r': (xx < mid).astype(np.float32)}
            groups = {k: list(v) for k, v in item['split']['targets'].items()}
        else:
            side = None
            groups = {None: item.get('targets') or []}

        base_mask = build_mask(item, ref_w, orig, parts, (W, H), order=order)
        folded = []
        for key, names in groups.items():
            mask = base_mask if side is None else base_mask * side[key]
            if float(mask.max()) <= 0:
                continue
            for name in names:
                part = parts.get(name)
                if part is None:
                    part = util.Part(name, np.zeros((H, W, 4), np.float32), 0, 0)
                canvas = _fold(part, ref_w, mask, item.get('alpha_mode', 'keep'))
                new_part = _from_canvas(name, canvas)
                parts[name] = new_part
                folded.append(dict(name=name, left=new_part.left, top=new_part.top,
                                   width=new_part.size[0], height=new_part.size[1],
                                   mask_px=int((mask > 0.5).sum()),
                                   alpha_px=int((new_part.img[..., 3] > 127).sum())))

        # check figure: original / ref / folded target, cropped to the item's box
        box = item.get('box') or [0, 0, W, H]
        z = int(ov.get('figure_zoom', 2))
        x0, y0, x1, y1 = (int(v) for v in box)
        tiles, labels = [], []
        orig_crop = util.on_checker(orig[y0:y1, x0:x1]).astype(np.float32)
        ref_crop = util.on_checker(ref_w[y0:y1, x0:x1]).astype(np.float32)
        for t, lab in ((orig_crop, 'M1'), (ref_crop, 'ref-pack')):
            tiles.append(cv2.resize(t, (t.shape[1] * z, t.shape[0] * z),
                                    interpolation=cv2.INTER_NEAREST))
            labels.append(lab)
        for f in folded:
            p = parts[f['name']]
            full = _to_canvas(p, (W, H))
            crop = util.on_checker(full[y0:y1, x0:x1]).astype(np.float32)
            tiles.append(cv2.resize(crop, (crop.shape[1] * z, crop.shape[0] * z),
                                    interpolation=cv2.INTER_NEAREST))
            labels.append(f'{f["name"]}')
        util.montage(tiles, cols=len(tiles), cell=(tiles[0].shape[1], tiles[0].shape[0]),
                     labels=labels).save(os.path.join(out, f'check_ov_{iid}.png'))

        items_metrics.append({'id': iid, 'file': item['file'], 'registered': True,
                              'reg': st, 'folded': folded,
                              'figure': f'check_ov_{iid}.png'})
        log(f'  override {iid}: reg inl={st["inliers"]} scale={st["scale"]} '
            f'rot={st["rotation_deg"]} t={st["translation"]} -> ' +
            ', '.join(f'{f["name"]}({f["mask_px"]}px)' for f in folded))

    metrics = {'enabled': True, 'dir': ov['dir'], 'items': items_metrics}
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    return parts, metrics
