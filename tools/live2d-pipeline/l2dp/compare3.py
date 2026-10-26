"""Three-way comparison: run3 / run4 / run5 on the poses all three exported.

The per-issue measurements are the same functions the See-through comparison uses
(`compare.issue*`), run once per run, so a number is never re-implemented for one side. Only the
poses every run actually has are compared here (rest, p1..p7): run3 predates the gaze/neck poses and
re-exporting them would mean starting psd2live just for a baseline row.
"""
import os

import cv2
import numpy as np

from . import compare, util

COMMON_POSES = [('rest', 'rest'), ('p1', 'ParamEyeLOpen=0'), ('p2', 'ParamEyeBallX=1,ParamEyeBallY=0.8'),
                ('p3', 'ParamEyeROpen=0'), ('p4', 'ParamMouthOpenY=1'), ('p7', 'ParamMouthOpenY=0.5'),
                ('p5', 'ParamAngleX=30'), ('p6', 'ParamAngleX=-30')]


def _crop(img, box, z, checker=True):
    if img is None:
        return None
    x0, y0, x1, y1 = [int(v) for v in box]
    x0, y0 = max(x0, 0), max(y0, 0)
    x1, y1 = min(x1, img.shape[1]), min(y1, img.shape[0])
    if x1 <= x0 or y1 <= y0:
        return None
    sub = img[y0:y1, x0:x1]
    rgb = util.on_checker(sub) if (checker and sub.shape[2] == 4) else sub[..., :3]
    return cv2.resize(rgb, (rgb.shape[1] * z, rgb.shape[0] * z), interpolation=cv2.INTER_NEAREST)


def _row(pairs, out, cols):
    tiles = [p[1] for p in pairs if p[1] is not None]
    labels = [p[0] for p in pairs if p[1] is not None]
    if tiles:
        util.montage(tiles, cols=cols, cell=(tiles[0].shape[1], tiles[0].shape[0]),
                     labels=labels).save(out)


def neck_band(orig, run, cfg):
    """Transparent pixels inside the artwork's neck-skin corridor (the step-8 definition)."""
    H, W = orig.shape[:2]
    layers6 = {l['name']: l for l in ((run.s6 or {}).get('layers') or [])}
    n = (cfg.get('step8_export') or {}).get('neck') or {}
    face = layers6.get('face') or {}
    band = None
    rect = None
    if face:
        face_bottom = int(face.get('top', 0) + face.get('height', 0))
        y0 = max(face_bottom - 4, 0)
        y1 = min(face_bottom + 90, H)
        x0 = max(int(face.get('left', 0)), 0)
        x1 = min(int(face.get('left', 0) + face.get('width', 0)), W)
        rgb = orig[..., :3]
        a = orig[..., 3] / 255.0
        mx = rgb.max(axis=2)
        mn = rgb.min(axis=2)
        chroma = (mx - mn) / np.maximum(mx, 1.0)
        warm = (rgb[..., 0] >= rgb[..., 1]) & (rgb[..., 1] >= rgb[..., 2])
        skin = (a > 0.9) & (chroma > 0.05) & (chroma < 0.22) & warm & (mx > 90)
        band = np.zeros((H, W), bool)
        band[y0:y1, x0:x1] = skin[y0:y1, x0:x1]
        nd = int((n.get('band') or {}).get('dilate_px', 1))
        if nd > 0:
            band = cv2.dilate(band.astype(np.uint8), np.ones((2 * nd + 1,) * 2, np.uint8)) > 0
        rect = [int(x0), int(y0), int(x1), int(y1)]
    out = dict(band_rect=rect, band_pixels=int(band.sum()) if band is not None else 0, poses={})
    if band is None:
        return out
    for tag in ('rest', 'p5', 'p6'):
        img = run.pose(tag)
        if img is None:
            continue
        a = img[..., 3] / 255.0
        out['poses'][tag] = dict(transparent=int(((a <= 0.5) & band).sum()))
    return out


def build(cfg, out_root, log=print):
    out = os.path.join(out_root, 'compare')
    os.makedirs(out, exist_ok=True)
    c = cfg.get('compare') or {}
    roots = c.get('three_way') or {}
    runs = [compare.Run(p) for p in (roots.get('run3'), roots.get('run4'), out_root)
            if p and os.path.isdir(p)]
    names = [r.name for r in runs]
    orig = util.load_rgba(cfg['input']['original_png'])
    assets = cfg.get('assets') or {}
    z = int(c.get('crop_zoom', 3))

    issues = {}
    for issue, fn in (('1_holes', compare.issue1_holes), ('2_hair_strip', compare.issue2_hair_strip),
                      ('7_hair_edge', compare.issue7_hair_edge), ('5_iris_rim', compare.issue5_iris_rim),
                      ('8_sclera', compare.issue8_sclera), ('9_mouth_mask', compare.issue9_mouth_mask),
                      ('10_mouth_states', compare.issue10_mouth_states),
                      ('11_mouth_ring', compare.issue11_mouth_ring),
                      ('12_blue_dot', compare.issue12_blue_dot)):
        issues[issue] = {r.name: fn(r, orig, cfg) for r in runs}
    for issue, fn in (('3_closed_eye', compare.issue3_closed_eye), ('4_mouth', compare.issue4_mouth)):
        issues[issue] = {r.name: fn(r, orig, cfg, assets) for r in runs}
    issues['6_lash_blobs'] = {r.name: compare.issue6_lash_blobs(r, cfg) for r in runs}
    issues['neck_band'] = {r.name: neck_band(orig, r, cfg) for r in runs}

    # ---- region boxes, taken from the newest run so all rows are the same crop
    new = runs[-1]
    def box_of(name, fallback):
        return new.layer_box(name) or fallback
    eye_box = None
    e = (new.s5 or {}).get('eyes', {}).get('l') or (new.s5 or {}).get('eyes', {}).get('r')
    if e:
        cx, cy = e['center_native']
        rr = max(e['ellipse']['rx'], e['ellipse']['ry']) * 2.0
        eye_box = [cx - rr, cy - rr, cx + rr, cy + rr]
    mouth_box = compare.mouth_roi(new, orig.shape) or [440, 470, 580, 570]
    neck_layers = {l['name']: l for l in ((new.s6 or {}).get('layers') or [])}
    fb = neck_layers.get('face') or {}
    chin = int(fb.get('top', 0) + fb.get('height', 0))
    neck_box = [int(fb.get('left', 380)) - 60, chin - 120,
                int(fb.get('left', 380) + fb.get('width', 260)) + 60, chin + 160]

    figs = {}

    def save(name, pairs, cols):
        path = os.path.join(out, name)
        _row(pairs, path, cols)
        figs[name] = path

    # full poses, rows = run
    for tag, pose in COMMON_POSES:
        pairs = [(f'{r.name} {tag}', _crop(r.pose(tag), [0, 0, orig.shape[1], orig.shape[0]], 1,
                                           checker=True)) for r in runs]
        pairs.append(('original', util.thumb(orig, max(orig.shape[:2]), checker=True)))
        save(f'check_cmp3_pose_{tag}.png', pairs, 1)

    for label, box, tags, zz in (('eye', eye_box, ['rest', 'p1', 'p2', 'p3'], z + 1),
                                 ('mouth', mouth_box, ['rest', 'p4', 'p7'], z + 1),
                                 ('neck', neck_box, ['rest', 'p5', 'p6'], z)):
        if box is None:
            continue
        pairs = []
        for tag in tags:
            for r in runs:
                info = ''
                if label == 'eye' and tag in ('p1', 'p3'):
                    side = 'l' if tag == 'p1' else 'r'
                    rec = (issues['3_closed_eye'][r.name] or {}).get(side) or {}
                    info = f' iris{rec.get("closed_iris_pixels")}'
                pairs.append((f'{tag} {r.name}{info}', _crop(r.pose(tag), box, zz)))
        pairs.append((f'original ({label})', _crop(orig, box, zz)))
        save(f'check_cmp3_{label}.png', pairs, len(runs))

    metrics = dict(step='compare3', runs=names,
                   three_way_roots={r.name: r.root for r in runs},
                   poses=[t for t, _ in COMMON_POSES],
                   boxes=dict(eye=eye_box, mouth=mouth_box, neck=neck_box),
                   issues=issues, figures=sorted(figs))
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    log(f'compare3: {len(figs)} figures, runs={names} -> {out}')
    return metrics


def run(cfg, out_root, log=print):
    return build(cfg, out_root, log=log)
