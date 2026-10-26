"""Step 8 - acceptance exports: posed PSDs, an Idle video, the web build, plus numeric checks."""
import glob
import http.server
import json
import os
import shutil
import socket
import socketserver
import subprocess
import threading

import cv2
import numpy as np
from PIL import Image
from psd_tools import PSDImage

from . import step7, util


# ------------------------------------------------------------------ exports

def export(cfg, out_root, target, out_dir, settings=None, log=print):
    """One psd2live export target from the run's committed MCP project."""
    session, _prepared = step7.prepare(cfg, out_root, log=log)
    result = session.export_target(target, out_dir, settings or {})
    files = result.get('files') or []
    return dict(target=target, directory=result.get('directory'), files=files,
                losses=result.get('losses') or [], settings=settings or {})


def load_posed(path):
    """Layered PNG-style PSD -> {layer name: (rgba canvas, bbox)} bottom -> top."""
    psd = PSDImage.open(path)
    W, H = psd.size
    layers = []
    for layer in psd.descendants():
        if layer.kind != 'pixel':
            continue
        rgba = util.layer_rgba(layer)
        layers.append(util.Part(layer.name, rgba, layer.bbox[0], layer.bbox[1]))
    return (W, H), layers


def load_pose_png(out, tag):
    """Composite of one exported pose directory (`p0` is rest), by pose tag."""
    d = os.path.join(out, 'p0' if tag == 'rest' else tag)
    psds = sorted(glob.glob(os.path.join(d, '*.psd')))
    if psds:
        size, parts = load_posed(psds[0])
        return util.composite(parts, size)
    q = os.path.join(out, f'pose_{tag}.png')
    return util.load_rgba(q) if os.path.exists(q) else None


def layer_alpha(parts, name, size):
    """Full-canvas alpha of a named layer (0..1)."""
    out = np.zeros((size[1], size[0]), np.float32)
    for p in parts:
        if p.name != name:
            continue
        h, w = p.img.shape[:2]
        x0, y0 = max(p.left, 0), max(p.top, 0)
        x1, y1 = min(p.left + w, size[0]), min(p.top + h, size[1])
        out[y0:y1, x0:x1] = np.maximum(out[y0:y1, x0:x1],
                                       p.img[y0 - p.top:y1 - p.top, x0 - p.left:x1 - p.left, 3] / 255.0)
    return out


def holes(alpha, min_area=50):
    """Transparent regions fully enclosed by the silhouette: the head-turn / split artifact."""
    mask = (alpha > 0.5).astype(np.uint8)
    filled = mask.copy()
    h, w = filled.shape
    ff = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(filled, ff, (0, 0), 1)
    inner = (filled == 0).astype(np.uint8)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(inner, 8)
    out = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        x, y, ww, hh = (int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP]),
                        int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT]))
        out.append(dict(area=area, bbox=[x, y, x + ww, y + hh],
                        centroid=[round(float(cent[i][0]), 1), round(float(cent[i][1]), 1)]))
    out.sort(key=lambda b: -b['area'])
    return out


def extent(alpha, thr=0.2):
    ys, xs = np.where(alpha > thr)
    if len(ys) == 0:
        return dict(pixels=0, bbox=None, height=0, width=0, centroid=None)
    return dict(pixels=int(len(ys)),
                bbox=[int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
                height=int(ys.max() - ys.min()) + 1, width=int(xs.max() - xs.min()) + 1,
                centroid=[round(float(xs.mean()), 1), round(float(ys.mean()), 1)])



def _posed_at(out, tag):
    d = os.path.join(out, 'p0' if tag == 'rest' else tag)
    psds = sorted(glob.glob(os.path.join(d, '*.psd')))
    if not psds:
        return None, None
    return load_posed(psds[0])


def opening_mask(out_root, side):
    """The artwork's eye opening for one side (step 5), full canvas, 0..1."""
    p = os.path.join(out_root, 'step5', f'opening-{side}.png')
    return (util.load_rgba(p)[..., 3] / 255.0) if os.path.exists(p) else None


def _bbox_of(mask):
    ys, xs = np.where(mask)
    if not len(ys):
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def skin_corridor(orig, layers6, cfg):
    """The artwork's own neck skin below the chin: where a hole means looking through the neck.

    A rectangle alone would count the hair and the coat as well, and those move with the head;
    the corridor is the skin the artwork draws between the chin and the collar, which no layer may
    show through. Returns (mask, bbox).
    """
    face = layers6.get('face')
    if not face:
        return None, None
    H, W = orig.shape[:2]
    chin = int(face['top'] + face['height'])
    y0 = max(chin - int(cfg.get('below_face_px', 4)), 0)
    y1 = min(chin + int(cfg.get('height_px', 90)), H)
    x0 = max(int(face['left']), 0)
    x1 = min(int(face['left'] + face['width']), W)
    rgb = orig[..., :3]
    a = orig[..., 3] / 255.0
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    chroma = (mx - mn) / np.maximum(mx, 1.0)
    warm = (rgb[..., 0] >= rgb[..., 1]) & (rgb[..., 1] >= rgb[..., 2])
    skin = (a > 0.9) & (chroma > 0.05) & (chroma < 0.22) & warm & (mx > 90)
    mask = np.zeros((H, W), bool)
    mask[y0:y1, x0:x1] = skin[y0:y1, x0:x1]
    grow = int(cfg.get('dilate_px', 4))
    if grow > 0:
        mask = cv2.dilate(mask.astype(np.uint8), np.ones((2 * grow + 1,) * 2, np.uint8)) > 0
    return (mask if mask.any() else None), [int(x0), int(y0), int(x1), int(y1)]


def iris_like_pixels(rgba, hue_centre, cfg, mask=None):
    """Count iris-coloured pixels (the drawn lid must leave none when the eye is shut)."""
    if hue_centre is None or rgba.size == 0:
        return None
    rgb = np.clip(rgba[..., :3], 0, 255).astype(np.uint8)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.int16)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    d = np.abs(h - int(hue_centre))
    d = np.minimum(d, 180 - d)
    lo, hi = cfg['iris_val_range']
    m = (d <= int(cfg['iris_hue_tol'])) & (s >= int(cfg['iris_min_sat'])) & \
        (v >= lo) & (v <= hi) & (rgba[..., 3] > 128)
    if mask is not None:
        m = m & (mask > 0.5)
    return int(m.sum())


def variant_checks(cfg, out, out_root, s5, s6, poses, log=print):
    """Drawn closed eyelid and open mouth: the numbers that say whether they are wired in."""
    c = cfg['step8_export']
    assets = cfg.get('assets') or {}
    eyes = (s5 or {}).get('eyes') or {}
    hue_centre = ((s5 or {}).get('iris_colour_estimate') or {}).get('hue_peak')
    out_checks = {}

    def load_pose(name):
        p = os.path.join(out, f'pose_{name}.png')
        return util.load_rgba(p) if os.path.exists(p) else None

    def opening_mask(side):
        p = os.path.join(out_root, 'step5', f'opening-{side}.png')
        return (util.load_rgba(p)[..., 3] / 255.0) if os.path.exists(p) else None

    # ---- closed eyelid ------------------------------------------------------
    eyelid = util.load_rgba(assets['eye_close']) if assets.get('eye_close') else None
    closed = {}
    for side in ('l', 'r'):
        eye = eyes.get(side)
        if not eye:
            continue
        cx, cy = eye['center_native']
        pad = int(max(eye['ellipse']['rx'], eye['ellipse']['ry']) * 1.5)
        x0, y0 = max(int(cx) - pad, 0), max(int(cy) - pad, 0)
        x1, y1 = int(cx) + pad, int(cy) + pad
        mask = opening_mask(side)
        mask = None if mask is None else mask[y0:y1, x0:x1]
        pose = 'p1' if side == 'l' else 'p3'
        rec = dict(pose=pose, roi=[x0, y0, x1, y1])
        closed_img = None
        for tag in ('rest', pose):
            img = load_pose(tag)
            if img is None:
                continue
            crop = img[y0:y1, x0:x1]
            rec[f'{tag}_iris_pixels'] = iris_like_pixels(crop, hue_centre, c['closed_eye'], mask)
            if tag == pose:
                closed_img = crop
        if eyelid is not None and closed_img is not None:
            ref = eyelid[y0:y1, x0:x1]
            gate = (ref[..., 3] > 128)
            rec['vs_eyelid_asset'] = dict(
                pixels=int(gate.sum()),
                mean_abs_color_diff=round(float(np.abs(closed_img[..., :3] - ref[..., :3])[gate].mean()), 2)
                if gate.any() else None)
        rec['pass_no_iris'] = bool(rec.get(f'{pose}_iris_pixels') == 0)
        closed[side] = rec
    out_checks['closed_eye'] = dict(eyes=closed,
                                    all_pass=bool(closed) and all(v['pass_no_iris'] for v in closed.values()),
                                    criterion='iris-hue pixels inside the eye opening at the closed pose = 0')

    # ---- open mouth ---------------------------------------------------------
    mouth_layers = [l for l in ((s6 or {}).get('layers') or [])
                    if l['name'] in ('mouth close', 'mouth small', 'mouth open')]
    mouth_roi = None
    if mouth_layers:
        x0 = min(l['left'] for l in mouth_layers)
        y0 = min(l['top'] for l in mouth_layers)
        x1 = max(l['left'] + l['width'] for l in mouth_layers)
        y1 = max(l['top'] + l['height'] for l in mouth_layers)
        px, py = int((x1 - x0) * 0.4), int((y1 - y0) * 0.4)
        H, W = (poses.get('rest') or {}).get('canvas') or [1024, 1536]
        mouth_roi = [max(x0 - px, 0), max(y0 - py, 0), min(x1 + px, W), min(y1 + py, H)]
    mouth = dict(roi=mouth_roi)
    if mouth_roi:
        rx0, ry0, rx1, ry1 = mouth_roi
        rest_img, open_img = load_pose('rest'), load_pose('p4')
        if rest_img is not None and open_img is not None:
            a = rest_img[ry0:ry1, rx0:rx1]
            b = open_img[ry0:ry1, rx0:rx1]
            d = np.abs(a[..., :3] - b[..., :3]).mean(axis=2)
            vis = (a[..., 3] > 32) | (b[..., 3] > 32)
            mouth['open_vs_rest'] = dict(
                diff_pixels=int((d > c['mouth_check']['diff_thr']).sum()),
                gate_pixels=int(vis.sum()),
                mean_abs_color_diff=round(float(d[vis].mean()), 2) if vis.any() else None)
        half_img = load_pose('p7')
        if half_img is not None:
            small = util.load_rgba(assets['mouth_small']) if assets.get('mouth_small') else None
            rec7 = dict(exported=True)
            if small is not None:
                h = half_img[ry0:ry1, rx0:rx1]
                s_ref = small[ry0:ry1, rx0:rx1]
                gate = (s_ref[..., 3] > 128)
                rec7['vs_mouth_small_asset'] = dict(
                    pixels=int(gate.sum()),
                    mean_abs_color_diff=round(float(np.abs(h[..., :3] - s_ref[..., :3])[gate].mean()), 2)
                    if gate.any() else None)
            if rest_img is not None:
                a = rest_img[ry0:ry1, rx0:rx1]
                b = half_img[ry0:ry1, rx0:rx1]
                d = np.abs(a[..., :3] - b[..., :3]).mean(axis=2)
                vis = (a[..., 3] > 32) | (b[..., 3] > 32)
                rec7['half_open_vs_rest'] = dict(
                    diff_pixels=int((d > c['mouth_check']['diff_thr']).sum()),
                    mean_abs_color_diff=round(float(d[vis].mean()), 2) if vis.any() else None)
            mouth['half_open'] = rec7
    out_checks['mouth_open'] = mouth

    # ---- sclera stays inside the artwork opening ----------------------------
    sclera = {}
    for side in ('l', 'r'):
        mask = opening_mask(side)
        if mask is None:
            continue
        rec = {}
        for pose in ('rest', 'p2'):
            d = os.path.join(out, 'p0' if pose == 'rest' else pose)
            psds = glob.glob(os.path.join(d, '*.psd'))
            if not psds:
                continue
            size_parts, parts = load_posed(psds[0])
            a = layer_alpha(parts, f'eyewhite-{side}', size_parts)
            rec[pose] = dict(
                sclera_pixels=int((a > 0.2).sum()),
                outside_opening_pixels=int(((a > 0.2) & (mask <= 0.1)).sum()))
        sclera[side] = rec
    out_checks['sclera_clipping'] = dict(
        eyes=sclera,
        all_pass=bool(sclera) and all(v.get('outside_opening_pixels', 0) == 0
                                      for e in sclera.values() for v in e.values()),
        criterion='sclera pixels outside the artwork eye opening = 0')

    # ---- iris lost when the gaze moves up-right -----------------------------
    clip = {}
    for side in ('l', 'r'):
        d = os.path.join(out, 'p2')
        psds = glob.glob(os.path.join(d, '*.psd'))
        rest_psd = glob.glob(os.path.join(out, 'p0', '*.psd'))
        if not psds or not rest_psd:
            continue
        size2, parts2 = load_posed(psds[0])
        _, parts0 = load_posed(rest_psd[0])
        a2 = layer_alpha(parts2, f'irides-{side}', size2)
        a0 = layer_alpha(parts0, f'irides-{side}', size2)
        n2, n0 = int((a2 > 0.2).sum()), int((a0 > 0.2).sum())
        clip[side] = dict(rest_iris_pixels=n0, p2_iris_pixels=n2,
                          clipped_pixels=max(n0 - n2, 0),
                          clipped_ratio=round(max(n0 - n2, 0) / n0, 4) if n0 else None)
    out_checks['iris_clip_p2'] = clip
    return out_checks


# ------------------------------------------------------------------ video

def probe_duration(ffprobe, path):
    out = subprocess.run([ffprobe, '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'default=nw=1:nk=1', path], capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def extract_frames(ffmpeg, video, out_dir, fps=None, every_s=None):
    os.makedirs(out_dir, exist_ok=True)
    subprocess.run([ffmpeg, '-v', 'error', '-y', '-i', video, '-vf',
                    f'fps={fps}' if fps else f'fps=1/{every_s}',
                    os.path.join(out_dir, 'f_%05d.png')], check=True)
    return sorted(glob.glob(os.path.join(out_dir, 'f_*.png')))


def lash_extent_from_frame(rgb, rois, lum_thr=110.0):
    """Vertical extent of the dark lash strokes inside each eye's lash box."""
    out = {}
    lum = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    for name, (x0, y0, x1, y1) in rois.items():
        sub = lum[y0:y1, x0:x1]
        ys, _xs = np.where(sub < lum_thr)
        out[name] = int(ys.max() - ys.min()) + 1 if len(ys) else 0
    return out


def iris_count_from_frame(rgb, rois, iris_rgb, tol):
    """Pixels matching the iris colour inside each eye box: the iris vanishes when the eye shuts."""
    out = {}
    target = np.asarray(iris_rgb, np.float32)
    for name, (x0, y0, x1, y1) in rois.items():
        box = rgb[max(y0, 0):y1, max(x0, 0):x1]
        if box.size == 0:
            out[name] = 0
            continue
        d = np.abs(box - target).mean(axis=2)
        out[name] = int((d < tol).sum())
    return out


def track_offset(frame_lum, anchor_lum, anchor_xy):
    """Global translation of the head: match a stable anchor (the nose) in the frame."""
    h, w = anchor_lum.shape[:2]
    fh, fw = frame_lum.shape[:2]
    if fh < h or fw < w:
        return 0, 0, 0.0
    res = cv2.matchTemplate(frame_lum, anchor_lum, cv2.TM_CCOEFF_NORMED)
    _min, maxv, _minloc, maxloc = cv2.minMaxLoc(res)
    return maxloc[0] - anchor_xy[0], maxloc[1] - anchor_xy[1], float(maxv)


def shifted(box, dx, dy):
    return (box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy)


# ------------------------------------------------------------------ web

def check_web(root, log=print):
    """Serve the export and fetch every referenced file over HTTP, then close the server."""
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=root, **k)
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    httpd = socketserver.TCPServer(('127.0.0.1', port), handler)
    httpd.RequestHandlerClass.log_message = lambda *a, **k: None
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    results = []
    try:
        import urllib.request
        base = f'http://127.0.0.1:{port}/'
        index = urllib.request.urlopen(base + 'index.html', timeout=10).read().decode('utf-8', 'replace')
        results.append(dict(path='index.html', status=200, bytes=len(index)))
        refs = set()
        for ext in ('.js', '.json', '.png', '.moc3', '.html'):
            refs |= {tok.strip('\'"') for tok in index.replace('"', ' ').replace("'", ' ').split()
                     if tok.strip('\'"').endswith(ext)}
        for ref in sorted(refs):
            if ref.startswith('http'):
                continue
            try:
                r = urllib.request.urlopen(base + ref.lstrip('/'), timeout=10)
                results.append(dict(path=ref, status=r.status, bytes=len(r.read())))
            except Exception as e:  # noqa: BLE001 - report, do not fail the run
                results.append(dict(path=ref, status='error', error=str(e)))
    finally:
        httpd.shutdown()
        httpd.server_close()
        t.join(timeout=5)
    ok = all(r.get('status') == 200 for r in results)
    return dict(port=port, ok=ok, requests=results, index_bytes=results[0]['bytes'] if results else 0)


# ------------------------------------------------------------------ main

def run(cfg, out_root, log=print):
    c = cfg['step8_export']
    out = os.path.join(out_root, 'step8')
    os.makedirs(out, exist_ok=True)
    s5_path = os.path.join(out_root, 'step5', 'metrics.json')
    s5metrics = util.read_json(s5_path) if os.path.exists(s5_path) else None
    orig = util.load_rgba(cfg['input']['original_png'])
    ffmpeg = cfg['env']['ffmpeg']
    ffprobe = shutil.which('ffprobe') or 'ffprobe'

    # ---- posed exports ------------------------------------------------------
    poses = dict(rest=None)
    poses.update(c['poses'])
    pose_data = {}
    for name, pose in poses.items():
        d = os.path.join(out, 'p0' if name == 'rest' else name)
        result = export(cfg, out_root, 'psd-pose', d, {'pose': pose} if pose else {}, log=log)
        size_parts = None
        p = None
        for f in glob.glob(os.path.join(d, '*.psd')):
            size_parts, p = load_posed(f)
            break
        if p is None:
            log(f'step8: pose {name} produced no PSD')
            pose_data[name] = dict(pose=pose, error='no psd')
            continue
        flat = util.composite(p, size_parts)
        util.save_rgba(flat, os.path.join(out, f'pose_{name}.png'))
        layers = {}
        for lname in ('eyewhite-l', 'eyewhite-r', 'irides-l', 'irides-r',
                      'eyelash-l', 'eyelash-r', 'eyebrow', 'mouth', 'neck',
                      'mouth close', 'mouth small', 'mouth open',
                      'eye close-l', 'eye close-r'):
            if any(q.name == lname for q in p):
                layers[lname] = extent(layer_alpha(p, lname, size_parts))
        silhouette = flat[..., 3] / 255.0
        hole_list = holes(silhouette, c['hole_min_area'])
        pose_data[name] = dict(pose=pose, canvas=list(size_parts),
                               layers=layers, losses=result.get('losses'),
                               silhouette=dict(opaque_pixels=int((silhouette > 0.5).sum()),
                                               holes=hole_list[:8], hole_count=len(hole_list)),
                               figure=f'pose_{name}.png')
        log(f'step8: pose {name} ({pose or "rest"}) -> {len(p)} layers, '
            f'losses={len(result.get("losses") or [])}')

    # ---- head-turn strength: the same PSD under two rig settings -------------
    hs = c.get('head_strength') or {}
    strength = dict(variants={}, poses=hs.get('poses') or {}, diff={})
    if hs.get('enabled', False) and (hs.get('variants') or {}):
        default_value = float((hs.get('variants') or {}).get('default', 1.0))
        session, _prepared = step7.prepare(cfg, out_root, log=log)
        for label, value in (hs.get('variants') or {}).items():
            session.settings({'headStrength': float(value)})
            rec = dict(head_strength=float(value), poses={})
            for tag, pose in strength['poses'].items():
                d = os.path.join(out, f'hs_{label}_{tag}')
                export(cfg, out_root, 'psd-pose', d, {'pose': pose}, log=log)
                psds = glob.glob(os.path.join(d, '*.psd'))
                if not psds:
                    continue
                size_hs, parts_hs = load_posed(psds[0])
                flat_hs = util.composite(parts_hs, size_hs)
                util.save_rgba(flat_hs, os.path.join(out, f'pose_hs_{label}_{tag}.png'))
                rec['poses'][tag] = dict(pose=pose, canvas=list(size_hs),
                                         silhouette=dict(
                                             opaque_pixels=int((flat_hs[..., 3] / 255.0 > 0.5).sum())),
                                         figure=f'pose_hs_{label}_{tag}.png')
            strength['variants'][label] = rec
            log(f'step8: head strength {label} = {value} -> {len(rec["poses"])} poses')
        session.settings({'headStrength': default_value})
        labels = list((hs.get('variants') or {}).keys())
        for tag in strength['poses']:
            imgs = {lbl: load_pose_png(out, f'hs_{lbl}_{tag}') for lbl in labels}
            if len(imgs) < 2:
                continue
            names = sorted(imgs)
            a, b = imgs[names[0]], imgs[names[1]]
            if a is None or b is None:
                continue
            d_ab = np.abs(a[..., :3] - b[..., :3]).mean(axis=2)
            strength['diff'][tag] = dict(
                pair=[names[0], names[1]],
                mean_abs_color_diff=round(float(d_ab.mean()), 3),
                max_abs_color_diff=round(float(d_ab.max()), 2),
                pixels_gt_10=int((d_ab > 10).sum()))

    # ---- numeric criteria ---------------------------------------------------
    checks = {}
    rest = pose_data.get('rest', {}).get('layers', {})

    c1 = {}
    for side in ('l', 'r'):
        close_pose = 'p1' if side == 'l' else 'p3'
        rest_h = rest.get(f'eyelash-{side}', {}).get('height', 0)
        close_h = pose_data.get(close_pose, {}).get('layers', {}).get(f'eyelash-{side}', {}).get('height', 0)
        wh_rest = rest.get(f'eyewhite-{side}', {}).get('height', 0)
        wh_close = pose_data.get(close_pose, {}).get('layers', {}).get(f'eyewhite-{side}', {}).get('height', 0)
        c1[f'eyelash-{side}'] = dict(pose=close_pose, rest_height=rest_h, closed_height=close_h,
                                     ratio=round(close_h / rest_h, 3) if rest_h else None)
        c1[f'eyewhite-{side}'] = dict(pose=close_pose, rest_height=wh_rest, closed_height=wh_close,
                                      ratio=round(wh_close / wh_rest, 3) if wh_rest else None)
    # Diagnostic only: closing is done by switching in the painted `eye close` layer, and psd2live
    # only translates the eyelash mesh, so a lash height ratio is not an acceptance criterion
    # (findings.md §3.1). The closed-eye acceptance is checks['closed_eye'].
    checks['eye_close'] = dict(eyes=c1)

    # iris inside the sclera when looking up-right
    p2 = pose_data.get('p2', {})
    contain = {}
    if p2.get('layers'):
        # rebuild alpha planes for p2 to measure overlap, not just bboxes
        d = os.path.join(out, 'p2')
        f = glob.glob(os.path.join(d, '*.psd'))
        if f:
            size_parts, parts2 = load_posed(f[0])
            for side in ('l', 'r'):
                iris = layer_alpha(parts2, f'irides-{side}', size_parts)
                scl = layer_alpha(parts2, f'eyewhite-{side}', size_parts)
                iris_m = iris > 0.2
                outside = int((iris_m & (scl <= 0.2)).sum())
                # clipping shows up as iris pixels sitting on the sclera boundary
                scl_edge = cv2.morphologyEx((scl > 0.5).astype(np.uint8), cv2.MORPH_GRADIENT,
                                            np.ones((3, 3), np.uint8)).astype(bool)
                touching = int((iris_m & scl_edge).sum())
                e_iris = extent(iris)
                e_scl = extent(scl)
                contain[side] = dict(
                    iris_pixels=e_iris['pixels'], sclera_pixels=e_scl['pixels'],
                    iris_outside_sclera_pixels=outside,
                    iris_pixels_on_sclera_edge=touching,
                    iris_centroid=e_iris['centroid'], sclera_centroid=e_scl['centroid'],
                    iris_bbox=e_iris['bbox'], sclera_bbox=e_scl['bbox'],
                    pass_no_overflow=outside == 0,
                    pass_no_clipping=touching == 0)
    checks['iris_containment'] = dict(
        pose=c['poses'].get('p2'),
        eyes=contain,
        all_pass=bool(contain) and all(v['pass_no_overflow'] for v in contain.values()),
        note='iris is masked by the sclera in the rig, so overflow is also reported together '
             'with boundary contact (the clipping signature)')

    s6metrics = util.read_json(os.path.join(out_root, 'step6', 'metrics.json')) \
        if os.path.exists(os.path.join(out_root, 'step6', 'metrics.json')) else None
    checks.update(variant_checks(cfg, out, out_root, s5metrics, s6metrics, pose_data, log=log))

    # ---- mouth states are mutually exclusive: one drawn state visible at a time ----
    mouth_state_names = ('mouth close', 'mouth small', 'mouth open')
    states = {}
    for value, tag in ((cfg.get('compare') or {}).get('round2') or {}).get('mouth_states') or []:
        lay = (pose_data.get(tag) or {}).get('layers') or {}
        visible = {n: lay[n]['pixels'] for n in mouth_state_names
                   if (lay.get(n) or {}).get('pixels')}
        states[value] = dict(pose=tag, visible_layers=visible, visible_count=len(visible),
                             pass_single=len(visible) == 1)
    checks['mouth_exclusive'] = dict(
        states=states, all_pass=bool(states) and all(v['pass_single'] for v in states.values()),
        criterion='exactly one drawn mouth state has pixels at each ParamMouthOpenY value')

    # ---- item 5: the gaze never leaves the eyelid opening -------------------
    gaze_cfg = c.get('gaze') or {}
    gaze = dict(poses=gaze_cfg.get('poses') or [], ring_px=int(gaze_cfg.get('ring_px', 3)),
                dark_lum=float(gaze_cfg.get('dark_lum', 80.0)), eyes={})
    if gaze['poses']:
        s6_layers = {l['name']: l for l in ((s6metrics or {}).get('layers') or [])}
        for side in ('l', 'r'):
            opening = opening_mask(out_root, side)
            if opening is None:
                continue
            rec = dict(opening_pixels=int((opening > 0.5).sum()),
                       opening_bbox=[int(v) for v in
                                     (_bbox_of(opening > 0.5) or [0, 0, 0, 0])])
            core = (opening > 0.5).astype(np.uint8)
            ring = (cv2.dilate(core, np.ones((2 * gaze['ring_px'] + 1,) * 2, np.uint8)) > 0) & (core == 0)
            rec['ring_pixels'] = int(ring.sum())
            per_pose = {}
            for tag in gaze['poses']:
                d = os.path.join(out, tag)
                psds = glob.glob(os.path.join(d, '*.psd'))
                if not psds:
                    continue
                size_p, parts_p = load_posed(psds[0])
                iris = layer_alpha(parts_p, f'irides-{side}', size_p)
                sclera = layer_alpha(parts_p, f'eyewhite-{side}', size_p)
                flat = util.composite(parts_p, size_p)
                outside = int(((iris > 0.2) & (opening <= 0.1)).sum())
                outside_sclera = int(((iris > 0.2) & (sclera <= 0.2)).sum())
                lum = cv2.cvtColor(np.clip(flat[..., :3], 0, 255).astype(np.uint8),
                                   cv2.COLOR_RGB2GRAY).astype(np.float32)
                dark_ring = int(((lum < gaze['dark_lum']) & ring).sum())
                per_pose[tag] = dict(pose=(poses.get(tag) or ''),
                                     iris_pixels=int((iris > 0.2).sum()),
                                     iris_outside_opening=outside,
                                     iris_outside_sclera=outside_sclera,
                                     dark_pixels_ring=dark_ring,
                                     pass_no_outside=outside == 0)
            rec['poses'] = per_pose
            rec['all_pass'] = bool(per_pose) and all(v['pass_no_outside'] for v in per_pose.values())
            gaze['eyes'][side] = rec
        gaze['all_pass'] = bool(gaze['eyes']) and all(v['all_pass'] for v in gaze['eyes'].values())
    checks['gaze_opening'] = gaze

    # ---- item 6: a solid neck, no gap between chin and collar ---------------
    neck_cfg = c.get('neck') or {}
    neck = dict(poses=neck_cfg.get('poses') or [], band_pose=neck_cfg.get('band_pose', 'rest'),
                dark_lum=neck_cfg.get('lum', 0))
    layers6 = {l['name']: l for l in ((s6metrics or {}).get('layers') or [])}
    band, band_rect = skin_corridor(orig, layers6, neck_cfg.get('band') or {})
    neck['band_box'] = band_rect
    neck['band_pixels'] = int(band.sum()) if band is not None else 0
    neck_rest = None
    rest_psds = glob.glob(os.path.join(out, 'p0', '*.psd'))
    if rest_psds:
        size_n, parts_n = load_posed(rest_psds[0])
        neck_alpha = layer_alpha(parts_n, 'neck', size_n)
        neck_rest = dict(layer_pixels=int((neck_alpha > 0.5).sum()),
                         layer_extent=extent(neck_alpha))
    if neck_rest is not None:
        face_bottom = (layers6.get('face') or {}).get('top', 0) + (layers6.get('face') or {}).get('height', 0)
        ext = neck_rest['layer_extent']
        neck_rest['below_face_bottom_px'] = (
            int(ext['bbox'][3] - face_bottom) if ext.get('bbox') else None)
        neck_rest['face_bottom'] = int(face_bottom)
    neck['rest'] = neck_rest
    if band is not None:
        per_pose = {}
        for tag in ['rest'] + list(neck['poses']):
            d = os.path.join(out, 'p0' if tag == 'rest' else tag)
            psds = glob.glob(os.path.join(d, '*.psd'))
            if not psds:
                continue
            size_p, parts_p = load_posed(psds[0])
            flat = util.composite(parts_p, size_p)
            alpha = flat[..., 3] / 255.0
            hole_px = int(((alpha <= 0.5) & band).sum())
            per_pose[tag] = dict(pose=poses.get(tag) or '', band_pixels=int(band.sum()),
                                 transparent_pixels=hole_px,
                                 pass_no_hole=hole_px == 0)
        neck['poses_checked'] = per_pose
        neck['all_pass'] = bool(per_pose) and all(v['pass_no_hole'] for v in per_pose.values())
        neck['criterion'] = ("transparent model pixels inside the artwork's neck-skin corridor "
                             "(chin to collar) = 0 at rest and at the turn/tilt poses")
    checks['neck_solid'] = neck

    # ---- item 7: one earring, one mouth ------------------------------------
    earcfg = c.get('accessory') or {}
    accessory = dict(poses=earcfg.get('poses') or [], colour_tol=float(earcfg.get('colour_tol', 24)),
                     reference_layer=earcfg.get('reference_layer', 'earwear'))
    ref_layer = accessory['reference_layer']
    # the earring must exist in exactly one place: its own layer. Earlier steps erase the
    # accessory's footprint from every other layer, so the measurable form is "opaque pixels
    # inside the earwear footprint, counted per layer" - 0 for all layers but earwear.
    ref_part = None
    for snap in (os.path.join(out_root, 'step6', 'layers'),
                 os.path.join(out_root, 'step6', 'variant_layers'),
                 os.path.join(out_root, 'step4', 'layers')):
        pth = os.path.join(snap, f'{ref_layer}.png')
        if os.path.exists(pth):
            origin = util.read_json(os.path.join(snap, f'{ref_layer}.json'))
            ref_part = util.Part(ref_layer, util.load_rgba(pth), *origin['origin'])
            break
    if ref_part is not None:
        core = cv2.erode((ref_part.img[..., 3] > 128).astype(np.uint8),
                         np.ones((3, 3), np.uint8)) > 0
        fp = np.zeros((orig.shape[0], orig.shape[1]), bool)
        fp[ref_part.top:ref_part.top + ref_part.size[1],
           ref_part.left:ref_part.left + ref_part.size[0]] = core
        per_layer = {}
        for name in layers6:
            if name == ref_layer:
                continue
            pth = None
            for snap in (os.path.join(out_root, 'step6', 'layers'),
                         os.path.join(out_root, 'step6', 'variant_layers')):
                cand = os.path.join(snap, f'{name}.png')
                if os.path.exists(cand):
                    pth = cand
                    break
            if pth is None:
                continue
            origin = util.read_json(os.path.join(os.path.dirname(pth), f'{name}.json'))
            img = util.load_rgba(pth)
            ox, oy = origin['origin']
            cx0, cx1 = max(ref_part.left, ox), min(ref_part.left + ref_part.size[0],
                                                 ox + img.shape[1])
            cy0, cy1 = max(ref_part.top, oy), min(ref_part.top + ref_part.size[1],
                                                oy + img.shape[0])
            if cx1 <= cx0 or cy1 <= cy0:
                per_layer[name] = dict(opaque=0, bright_pixels=0)
                continue
            local_fp = fp[cy0:cy1, cx0:cx1]
            sub = img[cy0 - oy:cy1 - oy, cx0 - ox:cx1 - ox]
            sel = local_fp & (sub[..., 3] > 0)
            per_layer[name] = dict(
                opaque=int(sel.sum()),
                bright_pixels=int((sel & (sub[..., :3].max(axis=2) > 120)).sum()) if sel.any() else 0)
        hair = [k for k in per_layer if 'hair' in k]
        limit = int(earcfg.get('hair_bright_max', 30))
        accessory['footprint_pixels'] = int(fp.sum())
        accessory['layer_residue'] = per_layer
        accessory['hair_copy_pixels'] = max((per_layer[k]['bright_pixels'] for k in hair),
                                            default=0)
        accessory['hair_copy_limit'] = limit
        accessory['criterion'] = ("bright pixels under the earring's own silhouette inside the "
                                  "hair layers (where the artwork is dark) <= "
                                  f"{limit} - a baked-in second earring shows up there")
        accessory['pass_footprint'] = accessory['hair_copy_pixels'] <= limit
        # pose-level witness: the earring's own layer must still be the only earring-shaped thing
        per_pose = {}
        for tag in accessory['poses']:
            size_p, parts_p = _posed_at(out, tag)
            if not parts_p:
                continue
            own = layer_alpha(parts_p, ref_layer, size_p)
            if own is None:
                continue
            n, _lab, st, _c = cv2.connectedComponentsWithStats((own > 0.2).astype(np.uint8), 8)
            areas = sorted((int(st[i, cv2.CC_STAT_AREA]) for i in range(1, n)), reverse=True)
            per_pose[tag] = dict(pose=poses.get(tag) or '',
                                 own_layer_pixels=int((own > 0.2).sum()),
                                 own_layer_components=len([x for x in areas if x >= 100]),
                                 areas=areas[:4])
        accessory['poses_checked'] = per_pose
        accessory['pass_single'] = bool(accessory['pass_footprint'])
        accessory['all_pass'] = accessory['pass_single']
    checks['accessory_unique'] = accessory

    # ---- video --------------------------------------------------------------
    video_dir = os.path.join(out, 'v')
    video_export = export(cfg, out_root, 'mp4', video_dir,
                          {'clip': c['video']['clip'], 'size': c['video']['size']}, log=log)
    videos = glob.glob(os.path.join(video_dir, '*.mp4'))
    video_metrics = dict(files=[os.path.basename(v) for v in videos],
                         losses=video_export.get('losses') or [])
    if videos:
        vid = videos[0]
        dur = probe_duration(ffprobe, vid)
        k = c['video']['size'] / max(pose_data['rest']['canvas'])
        rois, eye_rois = {}, {}
        for side in ('l', 'r'):
            bb = rest.get(f'eyelash-{side}', {}).get('bbox')
            if bb:
                # the eyebrow sits just above the lash box: keep the top margin tight so the
                # extent measures the lashes, not the brow
                rois[side] = (max(int(bb[0] * k) - 4, 0), max(int(bb[1] * k) - 2, 0),
                              int(bb[2] * k) + 4, int(bb[3] * k) + 4)
            wb = rest.get(f'eyewhite-{side}', {}).get('bbox')
            if wb:
                eye_rois[side] = (max(int(wb[0] * k) - 2, 0), max(int(wb[1] * k) - 2, 0),
                                  int(wb[2] * k) + 2, int(wb[3] * k) + 2)
        every = extract_frames(ffmpeg, vid, os.path.join(out, 'frames_05s'), every_s=c['video']['frame_step_s'])
        dense_dir = os.path.join('/tmp', 'l2d_idle_frames')
        shutil.rmtree(dense_dir, ignore_errors=True)
        dense = extract_frames(ffmpeg, vid, dense_dir, fps=c['blink']['idle_sample_fps'])

        # the idle sway moves the head, so track a stable anchor instead of trusting a fixed box
        iris_rgb = np.mean([np.asarray(e['iris_measured_rgb'], np.float32)
                            for e in (s5metrics or {}).get('eyes', {}).values()
                            if e.get('iris_measured_rgb')] or [[98, 97, 102]], axis=0)
        anchor = None
        rest_png = os.path.join(out, 'pose_rest.png')
        nose = next((q for q in util.load_parts(os.path.join(out_root, 'step4', 'layers'))
                     if q.name == c['tracking']['anchor_layer']), None) if os.path.exists(
            os.path.join(out_root, 'step4', 'layers', 'index.json')) else None
        if os.path.exists(rest_png) and nose is not None:
            restimg = util.load_rgba(rest_png)
            restimg = cv2.resize(restimg, (int(restimg.shape[1] * k), int(restimg.shape[0] * k)),
                                 interpolation=cv2.INTER_AREA)
            rest_lum = cv2.cvtColor(np.clip(restimg[..., :3], 0, 255).astype(np.uint8),
                                    cv2.COLOR_RGB2GRAY).astype(np.float32)
            ax0, ay0 = int(nose.left * k), int(nose.top * k)
            ax1, ay1 = int((nose.left + nose.size[0]) * k), int((nose.top + nose.size[1]) * k)
            anchor = (rest_lum[ay0:ay1, ax0:ax1], (ax0, ay0))
        series = []
        for i, f in enumerate(dense):
            rgb = np.array(Image.open(f).convert('RGB'), np.float32)
            lum = cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
            if anchor is not None:
                dx, dy, score = track_offset(lum, anchor[0], anchor[1])
            else:
                dx = dy = 0
                score = 0.0
            lash_boxes = {s: shifted(b, dx, dy) for s, b in rois.items()}
            eye_boxes = {s: shifted(b, dx, dy) for s, b in eye_rois.items()}
            series.append(dict(frame=i, t=round(i / c['blink']['idle_sample_fps'], 3),
                               offset=[dx, dy], match_score=round(score, 3),
                               lash=lash_extent_from_frame(rgb, lash_boxes),
                               iris=iris_count_from_frame(rgb, eye_boxes, iris_rgb,
                                                          c['blink']['iris_color_tol']),
                               eye_lum={s: round(float(lum[max(b[1], 0):b[3], max(b[0], 0):b[2]].mean()), 2)
                                        for s, b in eye_boxes.items()}))

        # criterion 1 (as specified): lash vertical extent collapses on a blink
        max_ext = {s: max((r['lash'].get(s, 0) for r in series), default=0) for s in ('l', 'r')}
        lash_blinks = [r for r in series
                       if any(max_ext[s] and r['lash'].get(s, 0) / max_ext[s] < c['blink']['min_lash_ratio']
                              for s in ('l', 'r'))]
        # criterion 2 (robust to the rig translating instead of squashing the lashes): the iris
        # is covered by the lid, so iris-coloured pixels drop away
        iris_median = {s: float(np.median([r['iris'].get(s, 0) for r in series])) for s in ('l', 'r')}
        iris_blinks = [r for r in series
                       if any(iris_median[s] and r['iris'].get(s, 0) < c['blink']['iris_drop_ratio'] * iris_median[s]
                              for s in ('l', 'r'))]
        n = c['blink']['idle_sample_fps']
        clusters = []
        for r in iris_blinks:
            if clusters and r['frame'] - clusters[-1][-1]['frame'] <= 2:
                clusters[-1].append(r)
            else:
                clusters.append([r])
        video_metrics.update(dict(
            duration_s=round(dur, 3), sampled_fps=n,
            frames_sampled=len(series), rois=rois, eye_rois=eye_rois,
            tracking=dict(anchor_layer=c['tracking']['anchor_layer'],
                          offset_x=[min(r['offset'][0] for r in series), max(r['offset'][0] for r in series)],
                          offset_y=[min(r['offset'][1] for r in series), max(r['offset'][1] for r in series)],
                          min_match_score=min(r['match_score'] for r in series)),
            iris_rgb=[round(float(v), 1) for v in iris_rgb],
            iris_median=iris_median,
            max_lash_extent=max_ext,
            lash_blink_frames=[r['t'] for r in lash_blinks][:20],
            lash_blink_count=len(lash_blinks),
            blink_clusters=[dict(start_t=c0[0]['t'], end_t=c0[-1]['t'], frames=len(c0),
                                 min_iris={s: min(r['iris'][s] for r in c0) for s in ('l', 'r')})
                            for c0 in clusters],
            blink_frame_count=len(iris_blinks),
            blink_found=bool(iris_blinks),
            series=series,
            frames_05s=[os.path.relpath(f, out) for f in every],
        ))
        shutil.rmtree(dense_dir, ignore_errors=True)

        # 0.5 s grid figure
        tiles = []
        for f in every:
            rgb = np.array(Image.open(f).convert('RGBA'))
            tiles.append(util.thumb(rgb, 220))
        if tiles:
            util.montage(tiles, cols=6, cell=(220, 320),
                         labels=[os.path.basename(f).split('.')[0] for f in every]).save(
                os.path.join(out, 'check_step8_video_frames.png'))

    checks['idle_blink'] = dict(
        found=video_metrics.get('blink_found'),
        frames=video_metrics.get('blink_frame_count'),
        clusters=video_metrics.get('blink_clusters'),
        lash_metric=dict(threshold=c['blink']['min_lash_ratio'],
                         frames=video_metrics.get('lash_blink_count'),
                         found=bool(video_metrics.get('lash_blink_count'))),
        iris_metric=dict(threshold=c['blink']['iris_drop_ratio'],
                         median=video_metrics.get('iris_median'),
                         found=bool(video_metrics.get('blink_found'))))

    # ---- web ---------------------------------------------------------------
    web_dir = os.path.join(out, 'web')
    web = dict(skipped=True)
    if c['web']:
        web_export = export(cfg, out_root, 'web', web_dir, {}, log=log)
        web = check_web(web_dir, log)
        web['files'] = sorted(os.path.basename(p) for p in glob.glob(os.path.join(web_dir, '*')))
        web['losses'] = web_export.get('losses') or []

    # ---- pose collage -------------------------------------------------------
    tiles, labels = [], []
    for name in poses:
        png = os.path.join(out, f'pose_{name}.png')
        if not os.path.exists(png):
            continue
        tiles.append(util.thumb(util.load_rgba(png), 260))
        labels.append(f'{name}: {poses[name] or "rest"}')
    if tiles:
        util.montage(tiles, cols=4, cell=(260, 390), labels=labels).save(
            os.path.join(out, 'check_step8_poses.png'))

    # eye close-up collage
    eye_tiles, eye_labels = [], []
    for name in poses:
        png = os.path.join(out, f'pose_{name}.png')
        if not os.path.exists(png):
            continue
        img = util.load_rgba(png)
        bb = rest.get('eyelash-l', {}).get('bbox')
        if not bb:
            continue
        x0, x1 = int(rest['eyelash-r']['bbox'][0]) - 30, int(bb[2]) + 30
        y0, y1 = int(rest['eyelash-r']['bbox'][1]) - 25, int(bb[3]) + 30
        crop = img[max(y0, 0):y1, max(x0, 0):x1]
        z = 3
        rgb = util.on_checker(crop)
        eye_tiles.append(cv2.resize(rgb, (rgb.shape[1] * z, rgb.shape[0] * z),
                                    interpolation=cv2.INTER_NEAREST))
        eye_labels.append(f'{name}: {poses[name] or "rest"}')
    if eye_tiles:
        util.montage(eye_tiles, cols=1, cell=(eye_tiles[0].shape[1], eye_tiles[0].shape[0]),
                     labels=eye_labels).save(os.path.join(out, 'check_step8_eyes.png'))

    # variant close-ups: drawn lid / drawn mouth against the artist's own patch
    var_tiles, var_labels = [], []
    assets = cfg.get('assets') or {}
    ce = checks.get('closed_eye', {}).get('eyes', {})
    if ce:
        roi = next(iter(ce.values()))['roi']
        x0, y0, x1, y1 = roi
        z = 4
        for tag in ('rest', ce['l']['pose'], ce['r']['pose']):
            png = os.path.join(out, f'pose_{tag}.png')
            if os.path.exists(png):
                crop = util.load_rgba(png)[y0:y1, x0:x1]
                rgb = util.on_checker(crop)
                var_tiles.append(cv2.resize(rgb, (rgb.shape[1] * z, rgb.shape[0] * z),
                                            interpolation=cv2.INTER_NEAREST))
                var_labels.append(f'posed {tag} x{z}')
        if assets.get('eye_close'):
            ref = util.load_rgba(assets['eye_close'])[y0:y1, x0:x1]
            rgb = util.on_checker(ref)
            var_tiles.append(cv2.resize(rgb, (rgb.shape[1] * z, rgb.shape[0] * z),
                                        interpolation=cv2.INTER_NEAREST))
            var_labels.append('artist eyelid_closed x4')
        util.montage(var_tiles, cols=2, cell=(var_tiles[0].shape[1], var_tiles[0].shape[0]),
                     labels=var_labels).save(os.path.join(out, 'check_step8_closed_eyes.png'))

    mo = checks.get('mouth_open', {})
    if mo.get('roi'):
        x0, y0, x1, y1 = mo['roi']
        z = 4
        tiles, labels = [], []
        for tag in ('rest', 'p4', 'p7'):
            png = os.path.join(out, f'pose_{tag}.png')
            if os.path.exists(png):
                crop = util.load_rgba(png)[y0:y1, x0:x1]
                rgb = util.on_checker(crop)
                tiles.append(cv2.resize(rgb, (rgb.shape[1] * z, rgb.shape[0] * z),
                                        interpolation=cv2.INTER_NEAREST))
                labels.append(f'posed {tag} x{z}')
        for key, nm in (('mouth_open', 'mouth_open'), ('mouth_small', 'mouth_small')):
            if assets.get(key):
                ref = util.load_rgba(assets[key])[y0:y1, x0:x1]
                rgb = util.on_checker(ref)
                tiles.append(cv2.resize(rgb, (rgb.shape[1] * z, rgb.shape[0] * z),
                                        interpolation=cv2.INTER_NEAREST))
                labels.append(f'artist {nm} x{z}')
        if tiles:
            util.montage(tiles, cols=3, cell=(tiles[0].shape[1], tiles[0].shape[0]),
                         labels=labels).save(os.path.join(out, 'check_step8_mouth.png'))

    metrics = dict(
        step=8,
        poses={k: {kk: vv for kk, vv in v.items() if kk != 'losses'} for k, v in pose_data.items()},
        losses={k: v.get('losses') for k, v in pose_data.items()},
        checks=checks,
        head_strength=strength,
        video=video_metrics,
        web=web,
        daemon=step7.session(cfg, out_root, log=log).stop_daemon(),
        figures=[f for f in ('check_step8_poses.png', 'check_step8_eyes.png',
                             'check_step8_closed_eyes.png', 'check_step8_mouth.png',
                             'check_step8_video_frames.png')
                 if os.path.exists(os.path.join(out, f))],
    )
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    step7.close_session()
    log('step8: eye close ratios ' + json.dumps(
        {k: v['ratio'] for k, v in checks['eye_close']['eyes'].items()}))
    mex = checks.get('mouth_exclusive') or {}
    log(f'step8: mouth exclusive pass={mex.get("all_pass")} '
        f'visible layers={ {k: v.get("visible_count") for k, v in (mex.get("states") or {}).items()} }; '
        f'neck corridor gaps={ {k: v.get("transparent_pixels") for k, v in (checks["neck_solid"]["poses_checked"] or {}).items()} }')
    log(f'step8: closed lid no-iris pass={checks["closed_eye"]["all_pass"]}; '
        f'sclera clip pass={checks["sclera_clipping"]["all_pass"]}; '
        f'iris clipped p2={ {k: v["clipped_ratio"] for k, v in checks["iris_clip_p2"].items()} }')
    log(f'step8: iris containment pass={checks["iris_containment"]["all_pass"]}; '
        f'blink found={checks["idle_blink"]["found"]} ({checks["idle_blink"]["frames"]} frames); '
        f'web ok={web.get("ok")}')
    return metrics
