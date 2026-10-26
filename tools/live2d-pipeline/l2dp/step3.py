"""Step 3 - map the See-through PSD back to original-image coordinates and verify the mapping."""
import os

import cv2
import numpy as np

from . import util


def run(cfg, out_root, log=print):
    c = cfg['step3_mapping']
    out = os.path.join(out_root, 'step3')
    os.makedirs(out, exist_ok=True)

    orig = util.load_rgba(cfg['input']['original_png'])
    psd_size, layers = util.psd_pixel_layers(cfg['input']['psd'])
    parts = [util.Part(l.name, util.layer_rgba(l), l.bbox[0], l.bbox[1]) for l in layers]
    canvas_psd = util.composite(parts, psd_size)

    mapping = util.Mapping(psd_size, (orig.shape[1], orig.shape[0]))
    log(f'psd={psd_size} orig={mapping.orig_size} s={mapping.s} padx={mapping.padx} pady={mapping.pady}')

    gate = c['compare_alpha_gate']

    def score(scale, dx, dy):
        m = mapping.warp(canvas_psd, scale, dx, dy)
        d, g = util.gated_diff(orig, m, gate)
        return d, g, m

    diff0, gate0, mapped0 = score(1.0, 0.0, 0.0)
    fwd0, bwd0, ea0, eb0 = util.edge_misalignment(orig, mapped0, gate, c['edge_sobel_percentile'])

    # ---- search around the formula result (translation + uniform scale) --------
    srch = c['search']
    tmax, tstep = srch['translate_px'], srch['translate_step_px']
    pmax, pstep = srch['scale_pct'], srch['scale_step_pct']
    offsets = np.arange(-tmax, tmax + 1e-9, tstep)
    scales = np.arange(1.0 - pmax / 100.0, 1.0 + pmax / 100.0 + 1e-9, pstep / 100.0)

    best = dict(diff=diff0, scale=1.0, dx=0.0, dy=0.0)
    table = []
    for k in scales:
        for dx in offsets:
            for dy in offsets:
                if k == 1.0 and dx == 0.0 and dy == 0.0:
                    continue
                d, _, _ = score(float(k), float(dx), float(dy))
                table.append(dict(scale=round(float(k), 5), dx=float(dx), dy=float(dy), diff=d))
                if d < best['diff']:
                    best = dict(diff=d, scale=float(k), dx=float(dx), dy=float(dy))
    # fine refinement of the winner
    for dx in np.arange(best['dx'] - tstep, best['dx'] + tstep + 1e-9, srch['refine_step_px']):
        for dy in np.arange(best['dy'] - tstep, best['dy'] + tstep + 1e-9, srch['refine_step_px']):
            for k in (best['scale'] - pstep / 100.0, best['scale'], best['scale'] + pstep / 100.0):
                d, _, _ = score(float(k), float(dx), float(dy))
                table.append(dict(scale=round(float(k), 5), dx=round(float(dx), 3),
                                  dy=round(float(dy), 3), diff=d))
                if d < best['diff'] - 1e-9:
                    best = dict(diff=d, scale=float(k), dx=float(dx), dy=float(dy))

    diff_b, gate_b, mapped_b = score(best['scale'], best['dx'], best['dy'])
    fwd_b, bwd_b, ea_b, eb_b = util.edge_misalignment(orig, mapped_b, gate, c['edge_sobel_percentile'])

    util.save_rgba(mapped0, os.path.join(out, 'mapped_formula.png'))
    util.save_rgba(mapped_b, os.path.join(out, 'mapped_best.png'))

    # ---- figures ---------------------------------------------------------------
    k = 0.5
    def half(a):
        h, w = a.shape[:2]
        return cv2.resize(a, (int(w * k), int(h * k)), interpolation=cv2.INTER_AREA)

    ov = util.overlay50(orig, mapped0)
    hm = util.diff_heatmap(orig, mapped0, gate0)
    ovb = util.overlay50(orig, mapped_b)
    hmb = util.diff_heatmap(orig, mapped_b, gate_b)
    sheet = util.montage([half(util.on_checker(orig)), half(util.on_checker(mapped0)), half(ov), half(hm),
                          half(util.on_checker(mapped_b)), half(ovb), half(hmb)],
                         cols=4, cell=(int(mapping.orig_size[0] * k), int(mapping.orig_size[1] * k)),
                         labels=['original', 'psd mapped (formula)', 'overlay 50%', 'diff heatmap x3',
                                 'psd mapped (search best)', 'overlay 50% (best)', 'diff heatmap (best)'])
    sheet.save(os.path.join(out, 'check_step3.png'))

    # zoom on the face for a closer look
    x0, y0 = int(mapping.orig_size[0] * 0.22), int(mapping.orig_size[1] * 0.16)
    x1, y1 = int(mapping.orig_size[0] * 0.78), int(mapping.orig_size[1] * 0.62)
    crop = lambda a: a[y0:y1, x0:x1]
    sheet2 = util.montage([crop(util.on_checker(orig)), crop(util.on_checker(mapped0)), crop(ov),
                           crop(hm), crop(util.on_checker(mapped_b)), crop(ovb)],
                          cols=3, cell=((x1 - x0), (y1 - y0)),
                          labels=['orig (face)', 'formula', 'overlay', 'diff', 'best', 'overlay best'])
    sheet2.save(os.path.join(out, 'check_step3_face.png'))

    improvement = (1.0 - best['diff'] / diff0) * 100.0
    metrics = dict(
        step=3,
        psd_size=list(psd_size),
        original_size=list(mapping.orig_size),
        formula=dict(s=mapping.s, padx=mapping.padx, pady=mapping.pady,
                     expected=dict(s=cfg['step3_mapping'].get('expected_s', 0.5))),
        formula_result=dict(mean_abs_color_diff=diff0,
                            edge_misalign_orig_to_mapped_px=fwd0,
                            edge_misalign_mapped_to_orig_px=bwd0,
                            edge_pixels=[ea0, eb0],
                            gated_pixels=int(gate0.sum())),
        search_result=dict(best=best,
                           best_result=dict(mean_abs_color_diff=diff_b,
                                            edge_misalign_orig_to_mapped_px=fwd_b,
                                            edge_misalign_mapped_to_orig_px=bwd_b),
                           improvement_pct=improvement,
                           significant=bool(improvement > 100.0 * (1 - 1 / c['report_improvement_ratio'])),
                           evaluations=len(table),
                           grid=dict(translate_px=tmax, translate_step_px=tstep,
                                     scale_pct=pmax, scale_step_pct=pstep),
                           top10=sorted(table, key=lambda r: r['diff'])[:10]),
        figures=['check_step3.png', 'check_step3_face.png'],
        artifacts=['mapped_formula.png', 'mapped_best.png'],
    )
    util.write_json(metrics, os.path.join(out, 'metrics.json'))
    log(f'step3: formula diff={diff0:.3f} edge={fwd0:.2f}/{bwd0:.2f}px; '
        f'best diff={diff_b:.3f} at scale={best["scale"]} d=({best["dx"]},{best["dy"]}) '
        f'improvement={improvement:.2f}%')
    return metrics
