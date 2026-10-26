"""Step 7 - generate the Live2D model with psd2live's headless MCP endpoint and inventory it.

The CLI (`psd2live run --input native.psd`) can only express preset mouth opacity ramps, so the
three drawn mouth states would cross-fade. Over MCP the same PSD is imported, generated, and the
mouth states get exclusive opacity keyforms; the model is then exported exactly as the CLI did
(moc3, cmo3, model3.json, physics3.json, motions). The session stays open for step 8, which
exports the poses, the video and the web build from the same committed model.
"""
import glob
import json
import os
import re

import numpy as np
from PIL import Image, ImageDraw

from . import live, util

_SESSION = None


def session(cfg, out_root, log=print):
    """The run's MCP session, started once (step 8 reuses it)."""
    global _SESSION
    if _SESSION is None:
        store = os.path.join(out_root, 'step7', 'mcp_store')
        _SESSION = live.Session(cfg, store, log=log)
        _SESSION.start()
    return _SESSION


def close_session(cfg=None):
    global _SESSION
    if _SESSION is not None:
        _SESSION.close()
        _SESSION = None


def inventory(root):
    files = []
    for base, _dirs, names in os.walk(root):
        for n in names:
            p = os.path.join(base, n)
            files.append(dict(path=os.path.relpath(p, root), bytes=os.path.getsize(p)))
    files.sort(key=lambda f: f['path'])
    return files


def collect_reports(root, files):
    reports = []
    for f in files:
        if not f['path'].endswith('.json'):
            continue
        p = os.path.join(root, f['path'])
        try:
            with open(p, encoding='utf-8') as fh:
                data = json.load(fh)
        except Exception:
            continue
        if isinstance(data, dict) and ('losses' in data or 'warnings' in data):
            reports.append(dict(path=f['path'], data=data))
    return reports


def figure(body, files, out_path):
    """Check figure: the texture atlas plus the layer stack psd2live actually built."""
    atlas = sorted(glob.glob(os.path.join(body, '**', 'texture_*.png'), recursive=True))
    tiles = []
    if atlas:
        tex = util.load_rgba(atlas[0])
        tiles.append(util.thumb(tex, 512))
    proj = None
    for f in files:
        if f['path'].endswith('.psd2live.json'):
            with open(os.path.join(body, f['path']), encoding='utf-8') as fh:
                proj = json.load(fh)
    lines = []
    if proj:
        lines.append('psd2live project: %s' % json.dumps(proj.get('summary'), ensure_ascii=False))
        lines.append('warnings: %s' % json.dumps(proj.get('warnings'), ensure_ascii=False))
        lines.append('')
        lines.append('%-3s %-26s %-10s %-12s %s' % ('#', 'layer', 'tag', 'side', 'type'))
        for i, l in enumerate(proj.get('layers', [])):
            lines.append('%-3d %-26s %-10s %-12s %s' % (i, str(l.get('source'))[:26], str(l.get('tag')),
                                                        str(l.get('side')), str(l.get('type'))))
    lines.append('')
    lines.append('outputs:')
    for f in files:
        lines.append('  %-46s %9d B' % (f['path'], f['bytes']))
    font_h, width = 11, 620
    text_h = font_h * (len(lines) + 1)
    sheet = Image.new('RGB', ((tiles[0].shape[1] if tiles else 512) + width,
                              max(text_h, 540)), (16, 16, 16))
    if tiles:
        sheet.paste(Image.fromarray(np.clip(tiles[0], 0, 255).astype(np.uint8), 'RGB'), (0, 0))
    d = ImageDraw.Draw(sheet)
    x0 = (tiles[0].shape[1] if tiles else 512) + 6
    for i, ln in enumerate(lines):
        d.text((x0, 4 + i * font_h), ln, fill=(225, 225, 225))
    sheet.save(out_path)
    return out_path


def settings_changes(cfg):
    """The generation settings the CLI path used (`--mesh-pixels`, mesh spacing 64, atlas 4096).

    `mouthOutlineEnabled: false` keeps psd2live from deriving its own lip outline from the mouth
    layers' contour: the drawn states carry their own lips, and the shared mouth mask makes that
    contour an ellipse.
    """
    c = cfg['step7_live'].get('generation') or {}
    out = {}
    if c.get('mesh_units'):
        out['meshUnits'] = str(c['mesh_units'])
    if c.get('mesh_spacing'):
        out['meshSpacing'] = int(c['mesh_spacing'])
    if c.get('atlas_size'):
        out['atlasSize'] = int(c['atlas_size'])
    if c.get('head_strength') is not None:
        out['headStrength'] = float(c['head_strength'])
    if 'mouth_outline' in c:
        out['mouthOutlineEnabled'] = bool(c['mouth_outline'])
    if 'see_through_eyes' in c:
        out['seeThroughEyes'] = bool(c['see_through_eyes'])
    if 'see_through_brows' in c:
        out['seeThroughBrows'] = bool(c['see_through_brows'])
    if 'generate_physics' in c:
        out['generatePhysics'] = bool(c['generate_physics'])
    if 'export_motions' in c:
        out['exportMotions'] = bool(c['export_motions'])
    return out


def prepare(cfg, out_root, log=print):
    """The run's MCP session with this PSD imported, generated and mouth states authored.

    Idempotent: running step 8 on its own imports what step 7 would have imported, and running
    both in one process reuses the project step 7 already generated.
    """
    live_session = session(cfg, out_root, log=log)
    existing = live_session.project_id()
    if existing:
        metrics = os.path.join(out_root, 'step7', 'metrics.json')
        if os.path.exists(metrics):
            data = util.read_json(metrics)
            return live_session, data
    psd = os.path.join(out_root, 'step6', 'native.psd')
    if not os.path.exists(psd):
        raise RuntimeError('step6 native.psd missing')
    log(f'step7: importing {psd} into psd2live over MCP')
    imported = live_session.import_psd(psd)
    changes = settings_changes(cfg)
    applied = live_session.settings(changes) if changes else {}
    del applied
    generated = live_session.generate()
    log(f'step7: layers {len(imported.get("layers") or [])}, settings {sorted(changes)}, '
        f'rig_generate changed {(generated or {}).get("changed")}')
    mouth = live.author_mouth_states(live_session, cfg, log=log)
    return live_session, dict(psd_import=dict(layers=imported.get('layers') or [],
                                              settings=changes),
                              mouth_states=mouth)


def run(cfg, out_root, log=print):
    c = cfg['step7_live']
    out = os.path.join(out_root, 'step7')
    os.makedirs(out, exist_ok=True)
    body = os.path.join(out, 'out')
    psd = os.path.join(out_root, 'step6', 'native.psd')
    if not os.path.exists(psd):
        raise RuntimeError('step6 native.psd missing')

    live_session, prepared = prepare(cfg, out_root, log=log)

    log('step7: exporting the model (moc3, cmo3, model3.json, physics3.json, motions)')
    model_result = live_session.export_model(body)
    files = inventory(body) if os.path.isdir(body) else []
    names = [f['path'] for f in files]
    counts = dict(
        moc3=sum(1 for n in names if n.lower().endswith('.moc3')),
        cmo3=sum(1 for n in names if n.lower().endswith('.cmo3')),
        model3_json=sum(1 for n in names if n.lower().endswith('model3.json')),
        physics3_json=sum(1 for n in names if n.lower().endswith('physics3.json')),
        motion3=sum(1 for n in names if n.lower().endswith('.motion3.json')),
    )
    missing = []
    if counts['moc3'] < 1:
        missing.append('moc3')
    if counts['cmo3'] < 1:
        missing.append('cmo3')
    if counts['model3_json'] < 1:
        missing.append('model3.json')
    if counts['physics3_json'] < 1:
        missing.append('physics3.json')
    if counts['motion3'] < c['motion3_min_count']:
        missing.append(f'motion3 (< {c["motion3_min_count"]}: got {counts["motion3"]})')

    losses = model_result.get('losses') or []
    notices = model_result.get('notices') or []
    warn_lines = [f'{x.get("feature")}/{x.get("handling")}: {x.get("note")}' for x in losses]
    warn_lines += [str(n) for n in notices]
    project_warnings = (live_session.project().get('quality') or {}).get('warnings') or []
    warn_lines += [str(w) for w in project_warnings] if isinstance(project_warnings, list) else []

    reports = collect_reports(body, files)
    fig = None
    if files:
        fig = os.path.basename(os.path.join(out, 'check_step7_outputs.png'))
        figure(body, files, os.path.join(out, fig))

    log_bytes = os.path.getsize(live_session.log_path) if os.path.exists(live_session.log_path) else 0
    metrics = dict(
        step=7,
        command=(f'psd2live mcp (headless) port from {live_session.endpoint}; '
                 f'project_import_psd {psd}; settings_update '
                 f'{sorted((prepared.get("psd_import") or {}).get("settings") or {})}; rig_generate; '
                 f'keyform_apply mouth states; project_export_model'),
        exit_code=0,
        output_dir=body,
        inventory=files,
        counts=counts,
        missing=missing,
        all_expected_present=not missing,
        log=live_session.log_path,
        log_bytes=log_bytes,
        warning_lines=warn_lines,
        warning_count=len(warn_lines),
        warnings_source='project_export_model losses/notices + workspace_inspect scope=project '
                        '(the CLI duplicate-layer-name warning is not part of the MCP surface)',
        reports=[dict(path=r['path'], data=r['data']) for r in reports],
        psd_import=prepared.get('psd_import') or {},
        mouth_states=prepared.get('mouth_states') or {},
        export_losses=losses,
        figures=[fig] if fig else [],
    )
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    log(f'step7: counts={counts} missing={missing} warnings={len(warn_lines)} '
        f'losses={len(losses)}')
    for ln in warn_lines[:10]:
        log('  ! ' + ln)
    return metrics
