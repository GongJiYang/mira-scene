"""Artwork eye opening: the region the character's own eye is visible in, taken from the original.

Used by step 5 (clip the rebuilt sclera to it) and by the comparison step (measure sclera
pixels outside it). Both callers must derive the same mask from the same numbers, so the
derivation lives here rather than in either step.
"""
import cv2
import numpy as np

from . import util


def ellipse_coords(shape, cx, cy, tilt):
    """Rotated ellipse coordinates (u, v) of every pixel, in local pixel units."""
    h, w = shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ca, sa = np.cos(tilt), np.sin(tilt)
    u = (xx - cx) * ca + (yy - cy) * sa
    v = -(xx - cx) * sa + (yy - cy) * ca
    return u, v


def artwork_opening(rgb, alpha, cx, cy, rx, ry, tilt, cfg, lash_lum=110.0):
    """Soft mask (0..1) of the eye opening drawn in the artwork inside the sclera ellipse.

    rgb/alpha are ROI-local float arrays; cx, cy, rx, ry, tilt describe the sclera ellipse in the
    same local space. The opening is the part of the ellipse that is neither skin nor lash: the
    artwork's own lid boundary. Returns (mask, info).
    """
    h, w = rgb.shape[:2]
    lum = rgb.astype(np.float32).mean(axis=2)
    u, v = ellipse_coords(rgb.shape, cx, cy, tilt)
    e = (u / max(rx, 1e-6)) ** 2 + (v / max(ry, 1e-6)) ** 2

    ring = (e >= 1.05) & (e <= 1.45) & (alpha > 0.85)
    if int(ring.sum()) < 40:
        return None, dict(skipped='no skin ring outside the sclera', ring_pixels=int(ring.sum()))
    skin = np.median(rgb[ring][:, :3], axis=0).astype(np.float32)
    skin_dist = np.abs(rgb[..., :3] - skin).mean(axis=2)
    warm = rgb[..., 0] - rgb[..., 2]
    # Mean distance alone cannot separate the lids from the whites: the artwork's sclera is
    # (189,186,185) against skin (203,161,145), i.e. 26 < skin_diff_thr, so it was cut out of the
    # opening and the face showed through the eye. Skin is the warm *and* bright region; lash
    # strokes are warm too but dark, and must stay inside the opening or the iris gets notched.
    skin_like = (warm > float(cfg.get('skin_warm_thr', 20.0))) & (
        lum > float(cfg.get('skin_warm_min_lum', 115.0))) & (
        skin_dist < float(cfg.get('skin_warm_dist_max', 90.0)))
    if cfg.get('exclude_lash_dark', False):
        lash_dark = lum < (lash_lum + float(cfg['lash_extra_lum']))
    else:
        lash_dark = np.zeros(lum.shape, bool)

    raw = (e <= 1.0) & (~skin_like) & (~lash_dark) & (alpha > 0.3)
    raw = raw.astype(np.uint8)
    k = max(int(cfg['close_px']), 1)
    raw = cv2.morphologyEx(raw, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    # fill enclosed holes: the pupil highlight and the iris core are not skin, but seams can be
    contours, _ = cv2.findContours(raw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    filled = np.zeros_like(raw)
    cv2.drawContours(filled, contours, -1, 1, -1)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(filled, 8)
    if n <= 1:
        return None, dict(skipped='no opening component found',
                          skin_rgb=[round(float(x), 1) for x in skin])
    main = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = (lab == main).astype(np.uint8)
    erode = int(cfg['erode_px'])
    if erode > 0:
        mask = cv2.erode(mask, np.ones((2 * erode + 1, 2 * erode + 1), np.uint8))
    soft = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), float(cfg['feather_px']))
    soft = np.clip(soft, 0, 1) * (e <= 1.05)
    info = dict(skin_rgb=[round(float(x), 1) for x in skin],
                skin_ring_pixels=int(ring.sum()),
                opening_pixels=int(mask.sum()),
                opening_bbox=[int(x) for x in cv2.boundingRect(mask)],
                ellipse_bbox=[int(2 * rx), int(2 * ry)])
    return soft.astype(np.float32), info


def sclera_outside_opening(sclera_alpha, opening, thr=0.2):
    """Sclera pixels the artwork's opening does not cover."""
    return int(((sclera_alpha > thr) & (opening <= 0.1)).sum())
