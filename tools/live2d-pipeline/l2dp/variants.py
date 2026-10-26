"""Artist-drawn variants: closed eyes and an open mouth, wired through psd2live's own naming.

psd2live's preset semantics for these tags (RigBuilder, LayerType.PRESET):

* `EYE_CLOSE`                  opacity = 1 - ParamEye{L,R}Open
* `MOUTH_CLOSE`                opacity = 1 - ParamMouthOpenY
* `MOUTH_OPEN`                 opacity = ramp(ParamMouthOpenY, 0 .. teethFade .. 1)

so naming a layer `eye close-l` / `mouth close` / `mouth open` is enough - no manifest, no editor
step. The artwork pieces we get are whole *face* patches (identical outside the feature they
change), so each one is masked twice: to the feature's own box, and to where it actually differs
from the original artwork. Anything else would paste the patch's eyes over the mouth variant.
"""
import os

import cv2
import numpy as np

from . import eyegeom, util


def _weight(diff, cfg):
    w = util.smoothstep(diff, float(cfg['diff_threshold']),
                        float(cfg['diff_threshold']) + float(cfg['diff_ramp']))
    sigma = float(cfg.get('feather_px', 0.0))
    if sigma > 0:
        w = cv2.GaussianBlur(w, (0, 0), sigma)
    return np.clip(w, 0, 1)


def _prepare(asset, orig, weight_cfg, min_alpha):
    diff = np.abs(asset[..., :3] - orig[..., :3]).mean(axis=2)
    w = _weight(diff, weight_cfg)
    a = (asset[..., 3] / 255.0) * w
    a = np.where(a >= float(min_alpha), a, 0.0)
    return np.concatenate([asset[..., :3], (a * 255.0)[..., None]], axis=2)


def _place(name, rgba_full):
    ys, xs = np.where(rgba_full[..., 3] > 8)
    if not len(ys):
        return None
    x0, y0 = int(xs.min()), int(ys.min())
    x1, y1 = int(xs.max()) + 1, int(ys.max()) + 1
    return util.Part(name, rgba_full[y0:y1, x0:x1], x0, y0)


def eye_close_layers(c, assets, eyes, orig, suffix_cfg):
    """`eye close-l` / `eye close-r` from the artist's closed-eyelid patch."""
    asset = util.load_rgba(assets['eye_close'])
    H, W = orig.shape[:2]
    out, stats = [], {}
    for side, eye in eyes.items():
        cx, cy = eye['center_native']
        rx, ry = eye['ellipse']['rx'], eye['ellipse']['ry']
        tilt = np.radians(eye['ellipse']['rotation_deg'])
        rad = max(rx, ry) * float(c['roi_expand'])
        x0, y0 = max(int(cx - rad), 0), max(int(cy - rad), 0)
        x1, y1 = min(int(cx + rad) + 1, W), min(int(cy + rad) + 1, H)
        u, v = eyegeom.ellipse_coords((y1 - y0, x1 - x0), cx - x0, cy - y0, tilt)
        roi = (((u / (rx * float(c['roi_expand']))) ** 2 +
                (v / (ry * float(c['roi_expand']))) ** 2) <= 1.0).astype(np.float32)
        roi = cv2.GaussianBlur(roi, (0, 0), max(float(c['feather_px']), 0.5))
        sub = _prepare(asset[y0:y1, x0:x1], orig[y0:y1, x0:x1], c, c['min_alpha'])
        sub[..., 3] *= roi
        full = np.zeros((H, W, 4), np.float32)
        full[y0:y1, x0:x1] = sub
        name = f'{c["name"]}{suffix_cfg["left" if side == "l" else "right"]}'
        part = _place(name, full)
        if part is None:
            stats[side] = dict(created=False)
            continue
        out.append(part)
        stats[side] = dict(created=True, layer=part.name, bbox=[part.left, part.top,
                                                              part.size[0], part.size[1]],
                           pixels=int((part.img[..., 3] > 127).sum()))
    return out, stats


def _bbox(mask):
    ys, xs = np.where(mask)
    if not len(ys):
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def mouth_mask(cfg, orig, assets, fallback_box):
    """One smooth mask shared by every mouth state.

    The union of the regions the drawn mouth patches change, enclosed in an ellipse grown by
    `expand_px` and feathered with a Gaussian of `feather_sigma`. Outside it every mouth layer is
    transparent, so all three states end on exactly the same pixels; inside it they are filled with
    the master's own pixels where the patch changes nothing, so the boundary colour is identical
    too. This is what removes the jagged mask edge (and the pink drips hanging under the lower lip)
    that run3 got from thresholding each patch's per-pixel difference.
    """
    c = cfg['mask']
    H, W = orig.shape[:2]
    thr = float(c['diff_threshold'])
    master = orig[..., :3]
    # The drawn patches are whole face blocks: outside the mouth they differ from the master too
    # (eyes, brows, chin), so the change region must be searched inside the mouth's own box.
    e = float(c.get('roi_expand', 1.8))
    bx0, by0, bx1, by1 = fallback_box
    bw, bh = bx1 - bx0, by1 - by0
    rx0 = max(int(bx0 - bw * (e - 1) / 2), 0)
    ry0 = max(int(by0 - bh * (e - 1) / 2), 0)
    rx1 = min(int(bx1 + bw * (e - 1) / 2) + 1, W)
    ry1 = min(int(by1 + bh * (e - 1) / 2) + 1, H)
    roi = np.zeros((H, W), bool)
    roi[ry0:ry1, rx0:rx1] = True
    change = np.zeros((H, W), bool)
    per_asset = {}
    for key in ('mouth_open', 'mouth_small'):
        path = assets.get(key)
        if not path or not os.path.exists(path):
            continue
        a = util.load_rgba(path)
        d = np.abs(a[..., :3] - master).mean(axis=2)
        m = (d > thr) & (a[..., 3] > 128) & roi
        per_asset[key] = dict(changed_pixels=int(m.sum()),
                              bbox=_bbox(m) or None)
        change |= m
    if not change.any():
        x0, y0, x1, y1 = fallback_box
    else:
        # keep only the pieces that belong to the mouth: the patches also change the cheeks and the
        # chin (they are whole-face blocks), and those would blow the ellipse up to the lower face
        n, lab, st, _cent = cv2.connectedComponentsWithStats(change.astype(np.uint8), 8)
        keep = np.zeros_like(change)
        for i in range(1, n):
            px, py, pw, ph = (int(st[i, cv2.CC_STAT_LEFT]), int(st[i, cv2.CC_STAT_TOP]),
                              int(st[i, cv2.CC_STAT_WIDTH]), int(st[i, cv2.CC_STAT_HEIGHT]))
            if px + pw > bx0 and px < bx1 and py + ph > by0 and py < by1:
                keep |= (lab == i)
        change = keep if keep.any() else change
        x0, y0, x1, y1 = _bbox(change)
    expand = float(c['expand_px'])
    cx, cy = (x0 + x1 - 1) / 2.0, (y0 + y1 - 1) / 2.0
    rx = (x1 - x0) / 2.0 + expand
    ry = (y1 - y0) / 2.0 + expand
    u, v = eyegeom.ellipse_coords((H, W), cx, cy, 0.0)
    inside = (((u / max(rx, 1e-6)) ** 2 + (v / max(ry, 1e-6)) ** 2) <= 1.0).astype(np.float32)
    soft = np.clip(cv2.GaussianBlur(inside, (0, 0), float(c['feather_sigma'])), 0, 1)
    info = dict(union_bbox=[int(x0), int(y0), int(x1), int(y1)],
                ellipse=dict(center=[round(float(cx), 2), round(float(cy), 2)],
                             rx=round(float(rx), 2), ry=round(float(ry), 2),
                             expand_px=expand, feather_sigma=float(c['feather_sigma'])),
                changed_pixels=int(change.sum()), per_asset=per_asset)
    return soft.astype(np.float32), info


def change_weight(orig, asset, cfg):
    """Soft, smoothed weight of where `asset` differs from the master (0..1)."""
    c = cfg['mask']
    d = np.abs(asset[..., :3] - orig[..., :3]).mean(axis=2)
    w = util.smoothstep(d, float(c['diff_threshold']),
                        float(c['diff_threshold']) + float(c['change_ramp']))
    k = int(c.get('change_morph_px', 0))
    if k >= 3:
        hard = (w > 0.5).astype(np.uint8)
        hard = cv2.morphologyEx(hard, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
        w = np.maximum(w, hard.astype(np.float32))
    sigma = float(c.get('change_blur_px', 0.0))
    if sigma > 0:
        w = cv2.GaussianBlur(w, (0, 0), sigma)
    return np.clip(w, 0, 1)


def erase_face_mouth(cfg, face, master, mask):
    """Paint the master's mouth out of the face layer under the mouth mask.

    The mouth states cover this area, so the face must not carry a second mouth (that is the pale
    ghost run3 showed under the closed mouth). Surrounding skin is inpainted inward.
    """
    c = cfg.get('face_inpaint') or {}
    if not c.get('enabled', False) or face is None:
        return face, dict(enabled=False)
    H, W = master.shape[:2]
    hard = (mask > 0.5).astype(np.uint8)
    d = int(c.get('dilate_px', 0))
    if d > 0:
        hard = cv2.dilate(hard, np.ones((2 * d + 1, 2 * d + 1), np.uint8))
    x0, y0 = max(face.left, 0), max(face.top, 0)
    x1, y1 = min(face.left + face.size[0], W), min(face.top + face.size[1], H)
    sub_mask = hard[y0:y1, x0:x1]
    rgba = face.img.copy()
    patch = rgba[y0 - face.top:y1 - face.top, x0 - face.left:x1 - face.left]
    if not sub_mask.any():
        return face, dict(enabled=True, painted_pixels=0)
    rgb8 = np.clip(patch[..., :3], 0, 255).astype(np.uint8)
    filled = cv2.inpaint(np.ascontiguousarray(rgb8), sub_mask, float(c.get('telea_radius', 6)),
                         cv2.INPAINT_TELEA).astype(np.float32)
    # feather the replacement so the lip's anti-aliased ring does not leave a step
    w = cv2.GaussianBlur(sub_mask.astype(np.float32), (0, 0), 1.2)
    w = np.maximum(w, sub_mask.astype(np.float32))[..., None]
    patch[..., :3] = patch[..., :3] * (1 - w) + filled * w
    return util.Part(face.name, rgba, face.left, face.top), dict(
        enabled=True, painted_pixels=int(sub_mask.sum()),
        dilate_px=d, telea_radius=float(c.get('telea_radius', 6)))


def mouth_layers(c, assets, orig, mask, log=None):
    """`mouth close` = the master's mouth; `mouth open` / `mouth small` = the drawn patches.

    All three sit on the same `mask` and carry master pixels outside their own change region, so
    they are pixel-identical everywhere except inside the lips.
    """
    H, W = orig.shape[:2]
    out, stats = [], {}
    master_rgb = orig[..., :3]
    alpha = (mask * 255.0)[..., None]

    close_rgba = np.concatenate([master_rgb, alpha], axis=2)
    part = _place(c['close_name'], close_rgba)
    if part is not None:
        out.append(part)
        stats['close'] = dict(layer=part.name, bbox=[part.left, part.top, part.size[0], part.size[1]],
                              pixels=int((part.img[..., 3] > 127).sum()), source='master artwork')
    for key, name in (('mouth_open', c['open_name']), ('mouth_small', c.get('small_name'))):
        if not name or not assets.get(key) or not os.path.exists(assets[key]):
            continue
        asset = util.load_rgba(assets[key])
        w = change_weight(orig, asset, c)[..., None]
        # the boundary band stays master pixels for every state: the patches also differ from the
        # artwork on the skin (they are whole-face blocks), and that must not reach the mask edge
        w = w * util.smoothstep(mask, 0.5, 0.98)[..., None]
        rgb = master_rgb * (1 - w) + asset[..., :3] * w
        rgba = np.concatenate([rgb, alpha], axis=2)
        part = _place(name, rgba)
        if part is None:
            stats[name] = dict(created=False)
            continue
        out.append(part)
        stats[name] = dict(layer=part.name, bbox=[part.left, part.top, part.size[0], part.size[1]],
                           pixels=int((part.img[..., 3] > 127).sum()),
                           changed_pixels=int(((w[..., 0] > 0.5) & (mask > 0.5)).sum()),
                           source=os.path.basename(assets[key]))
    stats['mask'] = dict(pixels=int((mask > 0.5).sum()),
                         alpha_gt_02=int((mask > 0.2).sum()),
                         bbox=[int(v) for v in cv2.boundingRect((mask > 0.02).astype(np.uint8))])
    return out, stats


def build(cfg, orig, parts, eyes):
    """Return (renamed stack entries, extra layers, metrics). `parts` is name -> Part."""
    c = cfg['variant_layers']
    assets = cfg['assets']
    extra, metrics = [], {}
    if 'eye_close' in c and eyes:
        ec = c['eye_close']
        layers, stats = eye_close_layers(ec, assets, eyes, orig,
                                        {'left': ec['suffix_left'], 'right': ec['suffix_right']})
        extra += layers
        metrics['eye_close'] = stats
    if 'mouth' in c:
        mc = c['mouth']
        fallback = [orig.shape[1] // 2 - 40, orig.shape[0] // 3, orig.shape[1] // 2 + 40,
                    orig.shape[0] // 3 + 40]
        if 'mouth' in parts:
            mb = parts['mouth']
            fallback = [mb.left, mb.top, mb.left + mb.size[0], mb.top + mb.size[1]]
        mask, mask_info = mouth_mask(mc, orig, assets, fallback)
        face = parts.get('face')
        face_part, face_info = erase_face_mouth(mc, face, orig, mask)
        if face_part is not None:
            parts['face'] = face_part
        layers, stats = mouth_layers(mc, assets, orig, mask)
        stats['mask'].update(mask_info)
        stats['face_inpaint'] = face_info
        extra += layers
        metrics['mouth'] = stats
    return extra, metrics
