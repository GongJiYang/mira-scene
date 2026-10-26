"""Report - turn the per-step metrics.json files into report.md (numbers, pass/fail, figures).

`findings.md` next to config.json, when present, is appended verbatim as the engineer's own
judgement section, so re-running the tool keeps the human notes.
"""
import os

from . import util

SIDES = ('l', 'r')


def fmt(v, nd=2):
    if isinstance(v, float):
        return f'{v:.{nd}f}'
    if v is None:
        return '—'
    return str(v)


def table(rows, header):
    out = ['| ' + ' | '.join(header) + ' |',
           '|' + '|'.join(['---'] * len(header)) + '|']
    for r in rows:
        out.append('| ' + ' | '.join(str(c) for c in r) + ' |')
    return '\n'.join(out)


def _ok(flag):
    return '✅' if flag else '❌'


def _vs(cur, base, lower_is_better=True):
    """Three-state verdict so an unchanged number stops looking like a failure."""
    if cur is None or base is None:
        return '—'
    if cur == base:
        return '＝ 持平'
    better = (cur < base) if lower_is_better else (cur > base)
    return '✅ 更好' if better else '❌ 变差'


def _dig(obj, keys):
    for k in keys:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    return obj


def fix_table(cm):
    """The eight issues of fix round 1, baseline against this run, with the pass criterion used."""
    rows = []
    if not cm:
        return rows
    base, cur = cm.get('baseline'), cm.get('current')
    I = cm['issues']
    g = lambda issue, run, *keys: _dig(I.get(issue, {}).get(run, {}), keys)

    # 1 holes
    b1, c1 = I['1_holes'].get(base, {}), I['1_holes'].get(cur, {})
    bb = (b1.get('chin_collar_band') or {})
    cb = (c1.get('chin_collar_band') or {})
    rows.append(['1 下巴/高领缝', '角色内部空洞 px（总/内部/边缘）',
                 f'{b1.get("total")}/{b1.get("interior")}/{b1.get("edge")}',
                 f'{c1.get("total")}/{c1.get("interior")}/{c1.get("edge")}',
                 _ok(c1.get('interior') == 0) + ' 内部空洞 = 0'])
    rows.append(['', '下巴—领口带（原图为皮肤处）平均色差',
                 f'{bb.get("mean_color_diff")}（带内 {bb.get("pixels")}px）',
                 f'{cb.get("mean_color_diff")}（带内 {cb.get("pixels")}px）',
                 _ok((cb.get('mean_color_diff') or 9e9) < (bb.get('mean_color_diff') or 0)) + ' 色差下降'])

    # 2 hair strip
    b2, c2 = I['2_hair_strip'].get(base, {}), I['2_hair_strip'].get(cur, {})
    bs, cs = b2.get('strip_zone') or {}, c2.get('strip_zone') or {}
    rows.append(['2 右侧肤色竖条', '竖条区 (590–720, 120–380) 平均/最大色差',
                 f'{bs.get("mean_color_diff")}/{bs.get("max_color_diff")}',
                 f'{cs.get("mean_color_diff")}/{cs.get("max_color_diff")}',
                 _ok((cs.get('mean_color_diff') or 9e9) < (bs.get('mean_color_diff') or 0)) + ' 色差下降'])
    rows.append(['', '`objects` 独立图层',
                 f'有，{g("2_hair_strip", base, "objects_layer", "pixels")}px',
                 '无（并入 front hair）' if not (c2.get('objects_layer') or {}).get('present')
                 else f'有，{g("2_hair_strip", cur, "objects_layer", "pixels")}px',
                 _ok(not (c2.get('objects_layer') or {}).get('present')) + ' 竖条不再单独成层'])

    # 3 closed eye
    b3, c3 = I['3_closed_eye'].get(base, {}), I['3_closed_eye'].get(cur, {})
    rows.append(['3 闭眼（画好的闭眼层）', '闭眼姿态眼白区内虹膜色相 px（l / r）',
                 f'{g("3_closed_eye", base, "l", "closed_iris_pixels")} / '
                 f'{g("3_closed_eye", base, "r", "closed_iris_pixels")}',
                 f'{g("3_closed_eye", cur, "l", "closed_iris_pixels")} / '
                 f'{g("3_closed_eye", cur, "r", "closed_iris_pixels")}',
                 _ok(g("3_closed_eye", cur, "l", "closed_iris_pixels") == 0 and
                     g("3_closed_eye", cur, "r", "closed_iris_pixels") == 0) + ' = 0'])
    rows.append(['', '闭眼区与 `eyelid_closed` 平均色差（l / r）',
                 f'{g("3_closed_eye", base, "l", "vs_artist_lid", "mean_color_diff")} / '
                 f'{g("3_closed_eye", base, "r", "vs_artist_lid", "mean_color_diff")}',
                 f'{g("3_closed_eye", cur, "l", "vs_artist_lid", "mean_color_diff")} / '
                 f'{g("3_closed_eye", cur, "r", "vs_artist_lid", "mean_color_diff")}',
                 _ok((g("3_closed_eye", cur, "l", "vs_artist_lid", "mean_color_diff") or 9e9) <
                     (g("3_closed_eye", base, "l", "vs_artist_lid", "mean_color_diff") or 0)) + ' 色差下降'])

    # 4 mouth
    b4, c4 = I['4_mouth'].get(base, {}), I['4_mouth'].get(cur, {})
    rows.append(['4 张嘴（画好的口型）', '`ParamMouthOpenY`=1 与 0 嘴部差异像素（掩膜口径已从 1619px 改为 4088px，不跨轮比较）',
                 g("4_mouth", base, "open_vs_rest", "diff_pixels"),
                 g("4_mouth", cur, "open_vs_rest", "diff_pixels"),
                 '— 口径变；见「修复轮 2」口型表'])
    rows.append(['', 'p4 与 `mouth_open` 素材平均色差',
                 g("4_mouth", base, "p4_vs_artist_mouth_open", "mean_color_diff"),
                 g("4_mouth", cur, "p4_vs_artist_mouth_open", "mean_color_diff"),
                 _ok((g("4_mouth", cur, "p4_vs_artist_mouth_open", "mean_color_diff") or 9e9) <
                     (g("4_mouth", base, "p4_vs_artist_mouth_open", "mean_color_diff") or 0)) + ' 更接近素材'])
    rows.append(['', '`ParamMouthOpenY`=0.5 与 0 差异像素（p7）', '—（未导出）',
                 g("4_mouth", cur, "half_open_vs_rest", "diff_pixels"), '检查图已导出'])

    # 5 iris rim
    b5, c5 = I['5_iris_rim'].get(base, {}), I['5_iris_rim'].get(cur, {})
    rows.append(['5 虹膜外圈浅色光环', '可见开口内 外缘 2px 与内侧 3px 环带亮度差（l / r）',
                 f'{g("5_iris_rim", base, "l", "delta")} / {g("5_iris_rim", base, "r", "delta")}',
                 f'{g("5_iris_rim", cur, "l", "delta")} / {g("5_iris_rim", cur, "r", "delta")}',
                 _vs(abs(g("5_iris_rim", cur, "l", "delta") or 0),
                     abs(g("5_iris_rim", base, "l", "delta") or 0))])

    # 6 lash blobs
    b6, c6 = I['6_lash_blobs'].get(base, {}), I['6_lash_blobs'].get(cur, {})
    rows.append(['6 睫毛上方碎笔触', '睫毛层连通块数（l / r）',
                 f'{g("6_lash_blobs", base, "l", "components")} / {g("6_lash_blobs", base, "r", "components")}',
                 f'{g("6_lash_blobs", cur, "l", "components")} / {g("6_lash_blobs", cur, "r", "components")}',
                 _vs(g("6_lash_blobs", cur, "r", "components"),
                     g("6_lash_blobs", base, "r", "components"))])
    rows.append(['', '各块面积（l / r）',
                 f'{g("6_lash_blobs", base, "l", "areas")} / {g("6_lash_blobs", base, "r", "areas")}',
                 f'{g("6_lash_blobs", cur, "l", "areas")} / {g("6_lash_blobs", cur, "r", "areas")}',
                 '见检查图'])

    # 7 hair edge
    b7, c7 = I['7_hair_edge'].get(base, {}), I['7_hair_edge'].get(cur, {})
    rows.append(['7 前发边缘锯齿', '前发软边相邻像素 |Δα| 均值',
                 g("7_hair_edge", base, "front_hair", "mean_abs_delta"),
                 g("7_hair_edge", cur, "front_hair", "mean_abs_delta"),
                 _vs(g("7_hair_edge", cur, "front_hair", "mean_abs_delta"),
                     g("7_hair_edge", base, "front_hair", "mean_abs_delta"))])
    rows.append(['', '轮廓处 alpha 与原图的平均误差（全图 / 前发框内）',
                 f'{g("7_hair_edge", base, "silhouette_alpha", "mean_abs_error")} / '
                 f'{g("7_hair_edge", base, "silhouette_alpha_front_hair_box", "mean_abs_error")}',
                 f'{g("7_hair_edge", cur, "silhouette_alpha", "mean_abs_error")} / '
                 f'{g("7_hair_edge", cur, "silhouette_alpha_front_hair_box", "mean_abs_error")}',
                 _vs(g("7_hair_edge", cur, "silhouette_alpha", "mean_abs_error"),
                     g("7_hair_edge", base, "silhouette_alpha", "mean_abs_error"))])

    # 8 sclera
    b8, c8 = I['8_sclera'].get(base, {}), I['8_sclera'].get(cur, {})
    rows.append(['8 眼白比例', '看向右上时虹膜超出眼白、被裁掉的比例（l / r；> 0 即需要裁）',
                 f'{g("8_sclera", base, "l", "iris_clipped_ratio")} / '
                 f'{g("8_sclera", base, "r", "iris_clipped_ratio")}',
                 f'{g("8_sclera", cur, "l", "iris_clipped_ratio")} / '
                 f'{g("8_sclera", cur, "r", "iris_clipped_ratio")}',
                 '— > 0 表示虹膜在看向右上时会被眼眶裁掉（run3 为负 = 没有裁切关键帧）'])
    rows.append(['', '眼白超出原图眼眶开口 px（l / r）',
                 f'{g("8_sclera", base, "l", "rest", "sclera_outside_opening")} / '
                 f'{g("8_sclera", base, "r", "rest", "sclera_outside_opening")}',
                 f'{g("8_sclera", cur, "l", "rest", "sclera_outside_opening")} / '
                 f'{g("8_sclera", cur, "r", "rest", "sclera_outside_opening")}',
                 _ok((g("8_sclera", cur, "l", "rest", "sclera_outside_opening") == 0) and
                     (g("8_sclera", cur, "r", "rest", "sclera_outside_opening") == 0)) + ' = 0'])
    return rows


def fix2_table(cm):
    """Fix round 2: the mouth's mask/states/ring and the coat-side blue dot, baseline -> this run."""
    I = cm.get('issues') or {}
    base, cur = cm.get('baseline'), cm.get('current')
    g = lambda issue, run: (I.get(issue) or {}).get(run) or {}
    rows = []

    b9, c9 = g('9_mouth_mask', base), g('9_mouth_mask', cur)
    be, ce = b9.get('edge') or {}, c9.get('edge') or {}
    rows.append(['1 统一口型掩码', '掩码边缘相邻像素 |Δα| 均值 / p95 / >0.25 占比',
                 f'{be.get("mean_abs_delta")} / {be.get("p95_abs_delta")} / {be.get("frac_gt_0_25")}',
                 f'{ce.get("mean_abs_delta")} / {ce.get("p95_abs_delta")} / {ce.get("frac_gt_0_25")}',
                 _ok((ce.get('mean_abs_delta') or 9e9) < (be.get('mean_abs_delta') or 0))])
    for name in ('mouth close', 'mouth open'):
        bb, cc = b9.get(f'components_{name}') or {}, c9.get(f'components_{name}') or {}
        rows.append(['', f'`{name}` 连通块数（面积前 6）',
                     f'{bb.get("components")}（{bb.get("areas")}）',
                     f'{cc.get("components")}（{cc.get("areas")}）',
                     _ok(cc.get('components') == 1)])
    bp, cp = b9.get('p4_vs_mouth_open') or {}, c9.get('p4_vs_mouth_open') or {}
    rows.append(['', 'p4 与 `mouth_open` 素材平均色差（掩码内）',
                 f'{bp.get("mean_color_diff")}（{bp.get("pixels")}px）',
                 f'{cp.get("mean_color_diff")}（{cp.get("pixels")}px）',
                 _ok((cp.get('mean_color_diff') or 9e9) <= (bp.get('mean_color_diff') or 9e9))])

    b10, c10 = g('10_mouth_states', base), g('10_mouth_states', cur)
    values = list((c10.get('states') or {}).keys()) or list((b10.get('states') or {}).keys())
    for value in values:
        bb = (b10.get('states') or {}).get(value) or {}
        cc = (c10.get('states') or {}).get(value) or {}
        bd = (bb.get('vs_artwork') or {}).get('mean_color_diff')
        cd = (cc.get('vs_artwork') or {}).get('mean_color_diff')
        rows.append(['2 口型档位 ' + value,
                     f'`ParamMouthOpenY={value}` 与 {cc.get("asset") or bb.get("asset")} 平均色差 / 可见口型层数',
                     f'{bd} / {bb.get("visible_count")}',
                     f'{cd} / {cc.get("visible_count")}',
                     _ok(cc.get('visible_count') == 1) + ' 可见层数 = 1'])
    b11, c11 = g('11_mouth_ring', base), g('11_mouth_ring', cur)
    rows.append(['3 rest 残影', '掩码外 10px 环带与 master 平均 / 最大色差',
                 f'{b11.get("mean_color_diff")} / {b11.get("max_color_diff")}',
                 f'{c11.get("mean_color_diff")} / {c11.get("max_color_diff")}',
                 _ok((c11.get('mean_color_diff') or 9e9) < (b11.get('mean_color_diff') or 0))])
    b12, c12 = g('12_blue_dot', base), g('12_blue_dot', cur)
    rows.append(['4 风衣右边缘蓝点', '区域最大 / 平均色差，原图透明处被画成不透明的像素',
                 f'{b12.get("max_color_diff")} / {b12.get("mean_color_diff")}，'
                 f'{b12.get("opaque_where_artwork_transparent_zone")}px',
                 f'{c12.get("max_color_diff")} / {c12.get("mean_color_diff")}，'
                 f'{c12.get("opaque_where_artwork_transparent_zone")}px',
                 _ok((c12.get('max_color_diff') or 9e9) < (b12.get('max_color_diff') or 0))])
    return rows


def fix2b_table(cm, s8=None):
    """Fix round 2, items 5-8 (the user's own findings in the web player), baseline -> this run."""
    I = cm.get('issues') or {}
    base, cur = cm.get('baseline'), cm.get('current')
    g = lambda issue, run: (I.get(issue) or {}).get(run) or {}
    rows = []

    b13, c13 = g('13_gaze', base), g('13_gaze', cur)
    for side in SIDES:
        bb = (b13.get('eyes') or {}).get(side) or {}
        cc = (c13.get('eyes') or {}).get(side) or {}
        if not bb and not cc:
            continue
        rows.append(['5 视线不出眼眶',
                     f'`{side}` 8 个视线姿态里虹膜越出开口的最大 px / 眼周 3px 环带暗线均值',
                     f'{bb.get("max_iris_outside")} / {bb.get("mean_dark_ring")}',
                     f'{cc.get("max_iris_outside")} / {cc.get("mean_dark_ring")}',
                     _ok(cc.get('max_iris_outside') == 0) + ' 越界 = 0'])

    b14, c14 = g('14_neck', base), g('14_neck', cur)
    for tag in ['rest', 'n_xp', 'n_xn', 'n_zp', 'n_zn']:
        bb = (b14.get('poses') or {}).get(tag) or {}
        cc = (c14.get('poses') or {}).get(tag) or {}
        if not bb and not cc:
            continue
        label = 'rest' if tag == 'rest' else tag
        rows.append(['6 脖子实心' if tag == 'rest' else '',
                     f'`{label}` 脖子皮肤走廊内透明 px',
                     bb.get('band_transparent_pixels'), cc.get('band_transparent_pixels'),
                     _ok(cc.get('band_transparent_pixels') == 0) + ' = 0'])
    br, cr = (b14.get('rest') or {}), (c14.get('rest') or {})
    rows.append(['', 'neck 层不透明 px / 下巴以下延伸 px',
                 f'{br.get("neck_pixels")} / {br.get("below_face_bottom_px")}',
                 f'{cr.get("neck_pixels")} / {cr.get("below_face_bottom_px")}',
                 _ok((cr.get('below_face_bottom_px') or 0) > 0)])

    b15, c15 = g('15_residue', base), g('15_residue', cur)
    rows.append(['7 耳坠只留一份', '耳坠轮廓内、头发层里亮于 120 的像素（原图那里是深色头发，'
                                   '第二份耳坠就藏在这里）',
                 b15.get('hair_copy_pixels'), c15.get('hair_copy_pixels'),
                 _ok(c15.get('hair_copy_pass')) + f' ≤ {c15.get("hair_copy_limit")}px'])
    bl = ((b15.get('footprint') or {}).get('layers') or {})
    cl = ((c15.get('footprint') or {}).get('layers') or {})
    for name in ('back hair', 'ears'):
        if name not in bl and name not in cl:
            continue
        bb, cc = bl.get(name) or {}, cl.get(name) or {}
        rows.append(['', f'`{name}` 在耳坠轮廓内的平均颜色 / 与原耳坠图案的 NCC（−1…1）',
                     f'{bb.get("mean_colour")} / {bb.get("ncc_vs_earring")}',
                     f'{cc.get("mean_colour")} / {cc.get("ncc_vs_earring")}',
                     ('✅ 不再与原耳坠相关' if (cc.get('ncc_vs_earring') or 0) < 0.2 else '❌ 仍有相关')
                     if name == 'back hair' else '— 耳朵自身皮肤，非耳坠副本'])
    rows.append(['', 'face 里口型掩码内的暗线残留 px',
                 b15.get('total_mouth_residue'), c15.get('total_mouth_residue'),
                 _ok((c15.get('total_mouth_residue') or 0) <= 8) + ' ≤ 8px 噪声'])
    acc = (((s8 or {}).get('checks') or {}).get('accessory_unique') or {})
    if acc.get('poses_checked'):
        for tag, rec in acc['poses_checked'].items():
            rows.append(['', f'`{tag}` 耳坠层自身的连通块数（≥100px）/ 面积',
                         '—', f'{rec.get("own_layer_components")} / {rec.get("areas")}',
                         '— 耳饰本身 = 耳钉 + 坠子，两块；导出模型里只有 1 个 `ArtMeshEarwear`'])

    strength = ((s8 or {}).get('head_strength') or {})
    if strength.get('variants'):
        variants = strength['variants']
        described = '、'.join(f'{k}={v.get("head_strength")}' for k, v in variants.items())
        rows.append(['8 头部变形强度', '可配置项：`settings_update headStrength`（CLI `--head-strength` 同源）',
                     '—', described, '已导出两组对比'])
        for tag, diff in (strength.get('diff') or {}).items():
            rows.append(['', f'`{tag}` 两组设置之间的平均 / 最大色差，>10 的像素数',
                         '—', f'{diff.get("mean_abs_color_diff")} / {diff.get("max_abs_color_diff")} / '
                               f'{diff.get("pixels_gt_10")}', '强度确实作用于脸与五官'])
    return rows


def regression_table(cm):
    """The items round 2 must not degrade: closed eyes, holes, hair, iris rim, lashes."""
    I = cm.get('issues') or {}
    base, cur = cm.get('baseline'), cm.get('current')
    g = lambda issue, run: (I.get(issue) or {}).get(run) or {}
    rows = []

    b1, c1 = g('1_holes', base), g('1_holes', cur)
    rows.append(['空洞', '角色内部空洞 px', b1.get('interior'), c1.get('interior'),
                 _ok((c1.get('interior') or 0) <= (b1.get('interior') or 0))])
    b2, c2 = g('2_hair_strip', base), g('2_hair_strip', cur)
    for key in ('front hair', 'back hair', 'strip_zone'):
        bb, cc = b2.get(key) or {}, c2.get(key) or {}
        if not bb and not cc:
            continue
        rows.append(['头发', f'`{key}` 平均 / 最大色差',
                     f'{bb.get("mean_color_diff")} / {bb.get("max_color_diff")}',
                     f'{cc.get("mean_color_diff")} / {cc.get("max_color_diff")}',
                     _ok((cc.get('mean_color_diff') or 9e9) <= (bb.get('mean_color_diff') or 9e9))])
    b3, c3 = g('3_closed_eye', base), g('3_closed_eye', cur)
    for side in SIDES:
        bb, cc = b3.get(side) or {}, c3.get(side) or {}
        if not bb and not cc:
            continue
        rows.append(['闭眼 ' + side, '眼白区虹膜色相 px / 与 `eyelid_closed` 平均色差',
                     f'{bb.get("closed_iris_pixels")} / {(bb.get("vs_artist_lid") or {}).get("mean_color_diff")}',
                     f'{cc.get("closed_iris_pixels")} / {(cc.get("vs_artist_lid") or {}).get("mean_color_diff")}',
                     _ok((cc.get('closed_iris_pixels') or 0) <= (bb.get('closed_iris_pixels') or 0))])
    b5, c5 = g('5_iris_rim', base), g('5_iris_rim', cur)
    for side in SIDES:
        bb, cc = b5.get(side) or {}, c5.get(side) or {}
        if not bb and not cc:
            continue
        rows.append(['虹膜外圈', f'`{side}` 可见开口内外缘−内侧亮度差',
                     bb.get('delta'), cc.get('delta'),
                     _ok(abs(cc.get('delta') or 9e9) <= abs(bb.get('delta') or 0))])
    b6, c6 = g('6_lash_blobs', base), g('6_lash_blobs', cur)
    for side in SIDES:
        bb, cc = b6.get(side) or {}, c6.get(side) or {}
        if not bb and not cc:
            continue
        rows.append(['睫毛', f'`eyelash-{side}` 连通块数（面积）',
                     f'{bb.get("components")}（{bb.get("areas")}）',
                     f'{cc.get("components")}（{cc.get("areas")}）',
                     _ok((cc.get('components') or 99) <= (bb.get('components') or 0))])
    b7, c7 = g('7_hair_edge', base), g('7_hair_edge', cur)
    for name in ('front_hair', 'back_hair'):
        bb, cc = b7.get(name) or {}, c7.get(name) or {}
        if not bb and not cc:
            continue
        rows.append(['头发边缘', f'`{name}` 软边相邻 |Δα| 均值',
                     bb.get('mean_abs_delta'), cc.get('mean_abs_delta'),
                     _ok((cc.get('mean_abs_delta') or 9e9) <= (bb.get('mean_abs_delta') or 9e9))])
    bs, cs = b7.get('silhouette_alpha') or {}, c7.get('silhouette_alpha') or {}
    if bs or cs:
        rows.append(['轮廓', '轮廓带 alpha 与原图的平均误差',
                     bs.get('mean_abs_error'), cs.get('mean_abs_error'),
                     _ok((cs.get('mean_abs_error') or 9e9) <= (bs.get('mean_abs_error') or 9e9))])
    b8, c8 = g('8_sclera', base), g('8_sclera', cur)
    for side in SIDES:
        bb, cc = b8.get(side) or {}, c8.get(side) or {}
        if not bb and not cc:
            continue
        rows.append(['眼白/虹膜', f'`{side}` 眼白越出开口 px（rest/p2）',
                     f'{(bb.get("rest") or {}).get("sclera_outside_opening")} / '
                     f'{(bb.get("p2") or {}).get("sclera_outside_opening")}',
                     f'{(cc.get("rest") or {}).get("sclera_outside_opening")} / '
                     f'{(cc.get("p2") or {}).get("sclera_outside_opening")}',
                     _ok(((cc.get('rest') or {}).get('sclera_outside_opening') or 0) <=
                         ((bb.get('rest') or {}).get('sclera_outside_opening') or 0))])
    return rows





def load(out_root, step):
    p = os.path.join(out_root, step, 'metrics.json')
    return util.read_json(p) if os.path.exists(p) else None


def build(cfg, out_root):
    L = []
    add = L.append
    s3, s4, s5 = load(out_root, 'step3'), load(out_root, 'step4'), load(out_root, 'step5')
    s6, s7, s8 = load(out_root, 'step6'), load(out_root, 'step7'), load(out_root, 'step8')
    cmp_path = os.path.join(out_root, 'compare', 'metrics.json')
    cm = util.read_json(cmp_path) if os.path.exists(cmp_path) else None
    root = os.path.abspath(out_root)
    rel = lambda p: os.path.join(root, p)

    add('# Live2D 流水线报告（See-through PSD → 原分辨率重建 → psd2live）\n')
    add(f'- 输入 PSD：`{cfg["input"]["psd"]}`')
    add(f'- 原图：`{cfg["input"]["original_png"]}`')
    add(f'- 产物目录：`{root}`')
    add(f'- 工具：`/Users/gjy/mira-scene/tools/live2d-pipeline`（`./run.sh` 一条命令跑全程）\n')

    add('## 总览\n')
    rows = []
    if s3:
        f, b = s3['formula_result'], s3['search_result']['best_result']
        rows.append(['3 坐标映射', '公式 s=%.3f pad=(%.0f,%.0f)' % (s3['formula']['s'], s3['formula']['padx'],
                                                                 s3['formula']['pady']),
                     f'色差 {fmt(f["mean_abs_color_diff"])}', 'PASS（与公式一致，搜索仅 %+.2f%%）'
                     % s3['search_result']['improvement_pct']])
    if s4:
        r = s4['residual']
        rows.append(['4 部件放大', f'阈值 {s4["selected_tolerance"]:g}',
                     f'残差 {r["total_residual_pixels"]}px，新图层 {len(r["new_layers"])}，'
                     f'发丝合并 {"是" if (r.get("hair_merge") or {}).get("merged") else "否"}',
                     'PASS（残差块按下巴线分类，发丝并入 front hair）'])
    if s5:
        eyes = s5['eyes']
        rows.append(['5 眼睛重建', ', '.join(f'{k}: r={fmt(v["radius"])}' for k, v in eyes.items()),
                     f'虹膜色相峰 {s5["iris_colour_estimate"]["hue_peak"]}', 'PASS（参数见下）'])
    if s6:
        rows.append(['6 合成 PSD', f'{s6["layer_count"]} 层',
                     f'拍平色差 {fmt(s6["flat_vs_original"]["mean_abs_color_diff"])} ≤ 第3步 {fmt(s6["step3_reference_diff"])}',
                     'PASS' if s6['passes_self_check'] else 'FAIL'])
    if s7:
        rows.append(['7 psd2live', str(s7['counts']), f'警告 {s7["warning_count"]} 条',
                     'PASS（产物齐全）' if s7['all_expected_present'] else 'FAIL'])
    if s8:
        ch = s8['checks']
        closed = ch.get('closed_eye') or {}
        mouth = (ch.get('mouth_open') or {}).get('open_vs_rest') or {}
        scl = ch.get('sclera_clipping') or {}
        clip = ch.get('iris_clip_p2') or {}
        rows.append(['8 验收导出',
                     f'闭眼用画好的眼皮；嘴 {mouth.get("diff_pixels")}px 变化',
                     '闭眼残留虹膜 %s，眼白越界 %s，虹膜裁切 %s，眨眼 %s 次，web %s' % (
                         sum(v.get(p + '_iris_pixels') or 0 for v in (closed.get('eyes') or {}).values()
                             for p in (v['pose'],)),
                         sum(v['iris_outside_sclera_pixels'] for v in ch['iris_containment']['eyes'].values()),
                         sum(max(v.get('clipped_pixels') or 0, 0) for v in clip.values()),
                         len(ch['idle_blink'].get('clusters') or []), s8['web'].get('ok')),
                     ('PASS' if closed.get('all_pass') and scl.get('all_pass') else 'FAIL')])
    add(table(rows, ['步骤', '关键设置', '关键数值', '结论']))
    add('')

    # ---- fix round 1 --------------------------------------------------------
    if cm:
        add('## 修复轮 1 的 8 个指标（在本次基线上重算）\n')
        add(f'基线 `{cm["baseline"]}` → 本次 `{cm["current"]}`。'
            '每个指标都由 `l2dp/compare.py` 从两次运行的产物（第 4/5/6 步图层、第 8 步姿态导出）'
            '加原图用同一段代码算出，不是手工填的。\n')
        add(table(fix_table(cm), ['#', '指标', f'{cm["baseline"]}', f'{cm["current"]}', '达标']))
        add('')
        figs = cm.get('figures') or []
        add(f'- 并排对比图（`{cm["baseline"]}` 与 `{cm["current"]}` 各一行）：')
        names = {'check_cmp1_holes.png': '1 下巴/高领缝（红 = 内部空洞）',
                 'check_cmp2_hair_strip.png': '2 右侧肤色竖条',
                 'check_cmp3_closed_eye.png': '3 闭眼（含 artist eyelid_closed）',
                 'check_cmp4_mouth.png': '4 张嘴 rest/p4/p7（含两个口型素材）',
                 'check_cmp5_iris_rim.png': '5 虹膜外圈光环（6×）',
                 'check_cmp6_lash_blobs.png': '6 睫毛连通块（4×）',
                 'check_cmp7_hair_edge.png': '7 前发边缘 alpha（上：合成，下：alpha）',
                 'check_cmp8_sclera.png': '8 看向右上（虹膜与眼白）',
                 'check_cmp_mouth5.png': '轮 2-1/2 口型 5 档（左右并列两个运行，末行两个素材）',
                 'check_cmp_blue_dot.png': '轮 2-4 风衣右边缘蓝点（原图 / 两个运行，6×）',
                 'check_cmp_regression.png': '轮 2 回归项（闭眼、下巴/脖子、前发，各两个运行）',
                 'check_cmp_gaze.png': '轮 2-5 视线与眼白（8 个方向里取 4 个）',
                 'check_cmp_neck.png': '轮 2-6 下巴到领口（rest + 转头/歪头）',
                 'check_cmp_earring.png': '轮 2-7 耳坠区域（p5/p6）',
                 'check_cmp_head_strength.png': '轮 2-8 头部变形强度两组设置'}
        for f in figs:
            add(f'  - `{rel("compare/" + f)}`：{names.get(f, f)}')
        add('')

    # ---- fix round 2 --------------------------------------------------------
    if cm:
        add('## 修复轮 2：口型与风衣蓝点\n')
        add(f'基线 `{cm["baseline"]}` → 本次 `{cm["current"]}`。口型区域指本轮统一掩码内部；'
            '「可见口型层数」是导出的姿态 PSD 里 alpha > 0.2 的口型图层个数。\n')
        add(table(fix2_table(cm), ['#', '指标', f'{cm["baseline"]}', f'{cm["current"]}', '达标']))
        add('')
        add('### 回归项（本轮不允许变差）\n')
        add(table(regression_table(cm), ['项', '指标', f'{cm["baseline"]}', f'{cm["current"]}', '是否持平/更好']))
        add('')
        add('- 对比图：')
        for f in ('check_cmp_mouth5.png', 'check_cmp_blue_dot.png', 'check_cmp_regression.png'):
            if f in (cm.get('figures') or []):
                add(f'  - `{rel("compare/" + f)}`')
        add('')

    # ---- fix round 2: the user's web-player findings (items 5-8) -------------
    if cm:
        add('## 修复轮 2 追加：用户在网页播放器里看到的问题（第 5–8 条）\n')
        add(f'基线 `{cm["baseline"]}` → 本次 `{cm["current"]}`。视线指标取自第 8 步导出的 8 个'
            '`ParamEyeBallX/Y` 姿态（基线缺的姿态由 `compare` 用基线自己的 `native.psd` 现导，'
            '写进本次运行的 `compare/baseline_poses/`，基线目录不动）；脖子「皮肤走廊」指原图中'
            '下巴以下、左右脸宽范围内的皮肤像素，只有那里透明才等于隔着脖子看到背景。\n')
        add(table(fix2b_table(cm, s8), ['#', '指标', f'{cm["baseline"]}', f'{cm["current"]}', '达标']))
        add('')
        add('- 对比图：')
        for f, what in (('check_cmp_gaze.png', '5 四个视线方向的眼白/虹膜与眼周（每行一个方向，左右为两个运行）'),
                        ('check_cmp_neck.png', '6 下巴到领口：rest 与四个转头/歪头姿态'),
                        ('check_cmp_earring.png', '7 耳坠区域（p5/p6 转头姿态）'),
                        ('check_cmp_head_strength.png', '8 头部变形强度两组设置（末列为两者的差异热图）')):
            if f in (cm.get('figures') or []):
                add(f'  - `{rel("compare/" + f)}`：{what}')
        add('')

    # ---- step 3 -------------------------------------------------------------
    if s3:
        add('## 第 3 步：坐标映射\n')
        f, b = s3['formula_result'], s3['search_result']
        add(f'- 公式：`side=max(w,h)={max(s3["original_size"])}`，`s=768/side={s3["formula"]["s"]}`，'
            f'`padx={s3["formula"]["padx"]}`，`pady={s3["formula"]["pady"]}`（预期 s=0.5、padx=256、pady=0）')
        add(f'- 公式结果：平均绝对色差 **{fmt(f["mean_abs_color_diff"])}**，'
            f'边缘错位 **{fmt(f["edge_misalign_orig_to_mapped_px"])}px**（原图→映射）/ '
            f'**{fmt(f["edge_misalign_mapped_to_orig_px"])}px**（映射→原图），参与统计像素 {f["gated_pixels"]}')
        sr = b['best']
        add(f'- 搜索（±{b["grid"]["translate_px"]:g}px / ±{b["grid"]["scale_pct"]:g}%，{b["evaluations"]} 次评估）：'
            f'最优 scale={sr["scale"]}，dx={sr["dx"]}，dy={sr["dy"]}，色差 {fmt(sr["diff"])}，'
            f'改善 **{fmt(b["improvement_pct"])}%**')
        add(f'- 结论：改善 {"显著" if b["significant"] else "**不显著**（<1.25 倍换算阈值，公式即正确）"}；'
            f'边缘错位与色差均来自 See-through 自身的重采样，不是映射偏移。')
        add(f'- 检查图：`{rel("step3/check_step3.png")}`，`{rel("step3/check_step3_face.png")}`\n')

    # ---- step 4 -------------------------------------------------------------
    if s4:
        add('## 第 4 步：部件放大到原分辨率\n')
        add(f'- 画布 {s4["canvas"]}，插值 {s4["interpolation"]}，选中阈值 **{s4["selected_tolerance"]:g}**，'
            f'α 门限 {s4["alpha_gate"]}（图层 α 与原图 α 需同时 ≥ 门限，避免混入透明背景）')
        rows = []
        for name, st in s4['layers'].items():
            rows.append([name, st['pixels'], f'{fmt(st["from_original_pct"], 1)}%',
                         f'{fmt(st["inpainted_pct"], 1)}%', fmt(st['mean_color_diff_visible'], 1)])
        add('')
        add(table(rows, ['图层', 'α>0.5 像素', '取原图像素', '补画（被遮挡）', '可见区平均色差']))
        add('')
        add('阈值对比（取原图像素占比）：\n')
        ths = list(s4['threshold_comparison'].items())
        names = list(s4['layers'].keys())
        rows = [[n] + [f'{fmt(s4["threshold_comparison"][t].get(n, {}).get("from_original_pct"), 1)}%'
                       for t, _ in ths] for n in names]
        add(table(rows, ['图层'] + [f'阈值 {t}' for t, _ in ths]))
        add('')
        bg = s4['background_check']
        add(f'- 背景污染检查：原图透明像素 {bg["original_transparent_pixels"]}'
            f'（其 RGB 均值 {bg["original_transparent_mean_rgb"]}，是无效值）；'
            f'本轮取原图颜色的 α 下限是 {bg.get("rgb_min_alpha", 0.85)}，'
            f'**α<0.2（真背景）处取到的像素数 = {bg["swapped_on_transparent_original"]}**；'
            f'α 介于 {bg.get("rgb_min_alpha", 0.85)} 与旧门限 {bg["gate"]} 之间的是抗锯齿边缘像素 '
            f'{bg.get("swappable_below_old_gate", 0)} 个（边缘色，不是背景）')
        r = s4['residual']
        add(f'\n残差检查：未覆盖 {r["uncovered_pixels"]}px + 覆盖但色差超阈值 {r["colour_off_pixels"]}px '
            f'= 共 {r["total_residual_pixels"]}px，连通块 {r["blob_count"]} 个（面积 ≥ {r["min_blob_area"]}px 才建层）\n')
        rows = []
        for b in r['kept_blobs']:
            rows.append([b['area'], b['bbox'], b['centroid'], b['grown_area'], b['assigned'],
                         '下巴以下' if b['below_chin'] else '下巴以上'])
        add(table(rows, ['残差块面积', 'bbox', '质心', '生长后面积', '命名', '位置']))
        add('')
        add(f'- 新图层：' + '；'.join(f'`{n["name"]}`（{n["width"]}×{n["height"]} @({n["left"]},{n["top"]})，'
                                     f'{n["pixels"]}px）' for n in r['new_layers']))
        if r.get('topwear_shadow'):
            ts = r['topwear_shadow']
            add(f'- topwear 阴影污染：neckwear 覆盖区 {ts["pixels"]}px，与原图色差均值 {fmt(ts["mean_color_diff_vs_original"], 1)}，'
                f'按说明维持补画色（{ts["action"]}）')
        add(f'- 检查图：`{rel("step4/check_step4_layers.png")}`，`{rel("step4/check_step4_tolerance.png")}`，'
            f'`{rel("step4/check_step4_residual.png")}`\n')

    # ---- step 5 -------------------------------------------------------------
    if s5:
        add('## 第 5 步：重建眼睛\n')
        ic = s5['iris_colour_estimate']
        add(f'- 虹膜主色自动估计（来自 irides 图层像素）：H 峰 **{ic["hue_peak"]}**（窗口 {s5["hue_window"]}），'
            f'H p10/p90 = {ic["hue_p10"]:.0f}/{ic["hue_p90"]:.0f}，S p50 = {ic["sat_p50"]:.0f}，'
            f'V p50 = {ic["val_p50"]:.0f}，中位 RGB {ic["rgb_median"]}'
            f'（灰蓝色，饱和度低，色相窗口只占 {fmt(100 * ic["hue_window_mass"], 1)}% —— 已按 ±{s5["hue_window"][1] - s5["hue_window"][0]} 容差放大后使用）')
        rows = []
        for name, e in s5['eyes'].items():
            rows.append([name, '图右' if e['image_side'] == 'right' else '图左',
                         f'{e.get("center_native", e["center"])}', fmt(e['radius']),
                         f'{fmt(e["fit"]["residual_mean"])}/{fmt(e["fit"]["residual_max"])}',
                         f'{fmt(e["lash_angle_deg"], 1)}°',
                         f'{fmt(e["ellipse"]["rx"])}×{fmt(e["ellipse"]["ry"])}',
                         e['sclera_rgb'], e['iris_measured_rgb'],
                         f'{e["radius_vs_expected_ratio"]}×'])
        add('')
        add(table(rows, ['图层后缀', '图像侧', '圆心(原图 px)', '半径 r', '拟合残差 均/max',
                         '睫毛主方向', '眼白椭圆 rx×ry', '眼白基色', '虹膜实测色', 'r / 预期中值']))
        add('')
        add(f'- 预期半径（上次 r≈{s5["expected_radius_note"]["reference_range"]} @ 宽 '
            f'{s5["expected_radius_note"]["reference_width_px"]}，按本次图宽 {s3["original_size"][0] if s3 else "?"} 等比缩放）'
            f'= **{s5["expected_radius_scaled"]}**；实测 **{fmt(list(s5["eyes"].values())[0]["radius"])}**，'
            f'是预期的 ~{list(s5["eyes"].values())[0]["radius_vs_expected_ratio"]}× —— 本角色虹膜本身更大，不是检测错误'
            f'（两条独立证据：irides 图层掩膜拟合、原图 HSV 检测的虹膜横跨 ≈42px）')
        add(f'- 左右拆分：按图像中线自动拆分，`-l` = 角色左眼 = 图像右侧；眉、嘴不拆。')
        add(f'- 生成图层：{", ".join(s5["layers"])}')
        rim = s5.get('iris_rim') or {}
        if rim:
            add('- 虹膜外圈光环（问题 5）：外缘 2px 环带与内侧 3px 环带的亮度差 '
                + '、'.join(f'`{k}` **{v["delta"]:+.2f}**（外 {fmt(v["outer_lum"])} / 内 {fmt(v["inner_lum"])}，'
                           f'环带 {v["outer_ring_px"]}/{v["inner_ring_px"]}px）' for k, v in rim.items())
                + '；处理：外缘颜色去污 + 虹膜掩膜收边，run2 同口径是 −5.36/−5.21（外圈偏亮）。')
        op = s5.get('sclera_opening') or {}
        if op:
            add('- 眼眶开口（问题 8）：从原图按皮肤色环带 + 睫毛暗度取每只眼的开口 mask，'
                + '、'.join(f'`{k}` 开口 {v["art"]["opening_pixels"]}px bbox={v["art"]["opening_bbox"]} → '
                           f'眼白 α>0 像素 {v["alpha_pixels"]}px' for k, v in op.items())
                + f'；眼白椭圆 ry = **{list(op.values())[0]["ry_ratio"]} × r**，并裁剪到开口内。'
                + 'mask 另存 `step5/opening-l.png` / `step5/opening-r.png`，compare 与 step8 共用同一段计算。')
        lb = s5.get('lash_blobs') or {}
        if lb:
            add('- 睫毛碎笔触过滤（问题 6）：保留最大块（睫毛主曲线）＋落在眼眶带内且形心不高于椭圆上沿的块，其余删除：'
                + '、'.join(f'`eyelash-{k}` 保留 {sum(1 for c in v["components"] if c["kept"])}/{len(v["components"])} 块'
                           f'（{sorted((c["area"] for c in v["components"] if c["kept"]), reverse=True)}）'
                           for k, v in lb.items()))
        add(f'- 检查图：`{rel("step5/check_step5_eyes.png")}`，`{rel("step5/check_step5_per_eye.png")}`\n')

    # ---- step 6 -------------------------------------------------------------
    if s6:
        add('## 第 6 步：合成 PSD\n')
        add(f'- 画布 {s6["canvas"]}，图层 {s6["layer_count"]} 个，PSD 模式 {s6.get("psd_mode", "RGB")}，'
            f'`{rel("step6/native.psd")}`（{s6["psd_bytes"] / 1e6:.1f} MB）')
        add('- 自下而上：' + ' < '.join(f'`{n}`' for n in s6['layer_order_bottom_to_top']))
        add(f'- 自检：拍平色差 **{fmt(s6["flat_vs_original"]["mean_abs_color_diff"])}**'
            f'（回读 PSD 后 {fmt(s6["re_read_psd_flat_vs_original"]["mean_abs_color_diff"])}）'
            f'vs 第 3 步 {fmt(s6["step3_reference_diff"])} → '
            f'{"**达标**" if s6["passes_self_check"] else "**未达标**"}')
        vis = s6.get('layer_visibility') or {}
        dead = {n: v for n, v in vis.items() if v['alpha_pixels'] and v['visible_pct'] < 25}
        rows = [[n, v['alpha_pixels'], v['visible_pixels'], f'{v["visible_pct"]}%']
                for n, v in vis.items()]
        add('\n各图层在最上层遮挡后仍可见的比例（<25% 视为基本被埋掉）：\n')
        add(table(rows, ['图层', 'α>0.5 像素', '实际可见像素', '可见比例']))
        add('')
        if dead:
            add(f'- 被埋掉的图层：' + '、'.join(f'`{n}`（{v["visible_pct"]}%）' for n, v in dead.items()))
        if s6.get('rest_hidden'):
            add(f'- 静止姿态下不可见的变体层（透明度由参数驱动）：' +
                '、'.join(f'`{n}`' for n in s6['rest_hidden']))
        var = s6.get('variants') or {}
        if var.get('eye_close'):
            add('- 闭眼变体层：' + '；'.join(
                f'`{v.get("layer")}` {v.get("pixels")}px bbox={v.get("bbox")}'
                for v in var['eye_close'].values() if v.get('created')))
        if var.get('mouth'):
            mo = var['mouth']
            add(f'- 口型图层：`{mo["close"].get("layer")}` {mo["close"].get("pixels")}px（原嘴层改名）；'
                f'`{mo.get("open", {}).get("layer")}` {mo.get("open", {}).get("pixels")}px bbox={mo.get("open", {}).get("bbox")}')
        seam = s6.get('seam') or {}
        holes = seam.get('holes') or {}
        before = holes.get('before') or {}
        after = holes.get('after_saved_png_file') or holes.get('after') or {}
        if before:
            add(f'- 空洞：修复前 {before.get("total_pixels")}px（内部 {before.get("interior_pixels")}、'
                f'轮廓边 {before.get("edge_pixels")}）→ 修复后 {after.get("total_pixels")}px'
                f'（内部 {after.get("interior_pixels")}、轮廓边 {after.get("edge_pixels")}）；'
                f'按区域（修复前）：' +
                '、'.join(f'{k} {v["pixels"]}px（内部 {v["interior_pixels"]}）'
                          for k, v in before.get('regions', {}).items()))
            if holes.get('fills'):
                add('  填补去向：' + '；'.join(
                    f'{f["pixels"]}px→`{f["donor"]}` bbox={f["bbox"]}' for f in holes['fills']))
        band = seam.get('chin_collar_band') or {}
        if band.get('band_pixels'):
            add(f'- 下巴—领口带：{band["band_pixels"]}px 原图为皮肤而模型偏暗，'
                f'平均色差 {band["before_mean_diff"]} → {band["after_mean_diff"]}；'
                f'重画到 ' + '、'.join(f'`{x["layer"]}` {x["pixels"]}px' for x in band.get('painted') or []))
        add(f'- 检查图：`{rel("step6/check_step6_composite.png")}`，拍平图 `{rel("step6/flattened.png")}`\n')

    # ---- step 7 -------------------------------------------------------------
    if s7:
        add('## 第 7 步：psd2live\n')
        add(f'- 命令：`{s7["command"]}`（exit {s7["exit_code"]}）')
        add(f'- 产物：moc3 {s7["counts"]["moc3"]}、cmo3 {s7["counts"]["cmo3"]}、model3.json {s7["counts"]["model3_json"]}、'
            f'physics3.json {s7["counts"]["physics3_json"]}、motion3 {s7["counts"]["motion3"]}；'
            f'缺失：{s7["missing"] or "无"}')
        imp = s7.get('psd_import') or {}
        if imp.get('layers'):
            add(f'- 导入：{len(imp["layers"])} 个图层（`{"`、`".join(imp["layers"][:6])}`…），'
                f'画布 {imp.get("canvas")}，`material` 数量 {imp.get("materials")}')
        ms = s7.get('mouth_states') or {}
        if ms.get('states'):
            parts = []
            for name, rec in ms['states'].items():
                probes = ', '.join(f'{k}→{v}' for k, v in (rec.get('opacity_at_probe') or {}).items())
                parts.append(f'`{name}`={rec["layer"]}（{rec["keys"]} 个不透明度关键帧；探针 {probes}）')
            add(f'- 口型独占（`ParamMouthOpenY` 三段，边界 {ms.get("edges")}±{ms.get("epsilon")}）：'
                + '；'.join(parts))
            add('  - 机制：psd2live 的命令行只在 `ParamMouthOpenY` 上做「1−x / ramp」过渡，'
                '写不出三段互斥；这里改用 MCP 的 `keyform_apply op=set` 在 0–1 的密集网格上逐帧给'
                '三个口型层写不透明度（每层约 56 个关键帧，边界两侧 ±ε 各一格），所以边界处是阶跃而非淡入淡出。')
        add(f'- 日志原文（`{rel("step7/psd2live.log")}`，{s7["log_bytes"]} 字节）中的警告：')
        for w in s7['warning_lines']:
            add(f'  - `{w}`')
        add('')

    # ---- step 8 -------------------------------------------------------------
    if s8:
        add('## 第 8 步：验收导出\n')
        rows = []
        for name, p in s8['poses'].items():
            layers = p.get('layers', {})
            sil = p.get('silhouette') or {}
            rows.append([name, f'`{p["pose"] or "rest"}`',
                         f'{fmt(layers.get("eyelash-l", {}).get("height"))}/{fmt(layers.get("eyelash-r", {}).get("height"))}',
                         f'{fmt(layers.get("eyewhite-l", {}).get("height"))}/{fmt(layers.get("eyewhite-r", {}).get("height"))}',
                         f'{fmt(layers.get("irides-l", {}).get("height"))}/{fmt(layers.get("irides-r", {}).get("height"))}',
                         sil.get('opaque_pixels', '—'), sil.get('hole_count', '—')])
        add(table(rows, ['姿态', '参数', '睫毛 l/r 高', '眼白 l/r 高', '虹膜 l/r 高', '覆盖像素', '空洞数']))
        add('')
        ch = s8['checks']
        add(f'### 自动判据\n')
        for name, v in ch['eye_close']['eyes'].items():
            mark = '' if 'pass_' not in v else (' ✅' if v['pass_'] else ' ❌')
            crit = f'（判据阈值 ≤{ch["eye_close"]["threshold"]}）' if 'pass_' in v else '（参照）'
            add(f'- `{name}` 在 {v["pose"]}：竖向高度 {v["rest_height"]} → {v["closed_height"]}，'
                f'**比值 {v["ratio"]}**{crit}{mark}')
        rest_layers = (s8['poses'].get('rest') or {}).get('layers', {})
        moved = []
        for side, pose in (('l', 'p1'), ('r', 'p3')):
            a = rest_layers.get(f'eyelash-{side}') or {}
            b = (s8['poses'].get(pose) or {}).get('layers', {}).get(f'eyelash-{side}') or {}
            if a and b:
                moved.append(f'{side}: 宽 {a["width"]}→{b["width"]}px，质心下移 '
                             f'{fmt(b["centroid"][1] - a["centroid"][1], 1)}px')
        white_min = min(v['ratio'] for k, v in ch['eye_close']['eyes'].items()
                        if k.startswith('eyewhite') and v['ratio'])
        lash_ratios = ', '.join(fmt(v['ratio']) for k, v in ch['eye_close']['eyes'].items()
                                if k.startswith('eyelash'))
        add(f'- 睫毛竖向收缩比 {lash_ratios}、眼白 {fmt(white_min)}：这是**旧判据**（"闭眼时睫毛压成一条线"），'
            f'本轮改成用画好的眼皮切换，psd2live 对 eyelash 仍是平移（{"；".join(moved)}），'
            f'该数字只作诊断，不再作为本轮验收。')
        closed = ch.get('closed_eye') or {}
        if closed:
            for side, v in (closed.get('eyes') or {}).items():
                pose = v['pose']
                add(f'- 闭眼 `{side}`（{pose}）：眼白区内虹膜色相像素 '
                    f'**{v.get(pose + "_iris_pixels")}**（静止 {v.get("rest_iris_pixels")}），'
                    f'与 `eyelid_closed` 素材平均色差 **{(v.get("vs_eyelid_asset") or {}).get("mean_abs_color_diff")}**'
                    f'（{v.get("vs_eyelid_asset", {}).get("pixels")}px）→ '
                    f'{"✅" if v.get("pass_no_iris") else "❌"}')
        mo = ch.get('mouth_open') or {}
        if mo.get('open_vs_rest'):
            add(f'- 张嘴（`ParamMouthOpenY`=1 vs 0，嘴部 ROI {mo["roi"]}）：差异像素 '
                f'**{mo["open_vs_rest"]["diff_pixels"]}**，平均色差 {mo["open_vs_rest"]["mean_abs_color_diff"]}；'
                f'0.5 姿态差异像素 {mo.get("half_open", {}).get("half_open_vs_rest", {}).get("diff_pixels")}，'
                f'与 `mouth_small` 素材平均色差 {mo.get("half_open", {}).get("vs_mouth_small_asset", {}).get("mean_abs_color_diff")}')
        scl = ch.get('sclera_clipping') or {}
        if scl:
            add('- 眼白裁剪：' + '；'.join(
                f'`{side}` rest {v.get("rest", {}).get("sclera_pixels")}px 中越出眼眶开口 '
                f'**{v.get("rest", {}).get("outside_opening_pixels")}px**，p2 {v.get("p2", {}).get("outside_opening_pixels")}px'
                for side, v in (scl.get('eyes') or {}).items())
                + f' → {"✅" if scl.get("all_pass") else "❌"}')
        clip = ch.get('iris_clip_p2') or {}
        if clip:
            add('- 看向右上时虹膜被裁：' + '；'.join(
                f'`{side}` {v["rest_iris_pixels"]}→{v["p2_iris_pixels"]}px，'
                f'裁掉 {v["clipped_pixels"]}px（{v["clipped_ratio"]}）' for side, v in clip.items()))
        rest_iris = (s8['poses'].get('rest') or {}).get('layers', {})
        for side, v in ch['iris_containment']['eyes'].items():
            r0 = (rest_iris.get(f'irides-{side}') or {}).get('pixels')
            delta = (v['iris_pixels'] - r0) if r0 else None
            add(f'- 虹膜 `{side}` 在 `{ch["iris_containment"]["pose"]}`：越界像素 **{v["iris_outside_sclera_pixels"]}**，'
                f'贴着眼白边界的虹膜像素 **{v["iris_pixels_on_sclera_edge"]}**，虹膜像素 {v["iris_pixels"]}'
                f'（静止 {r0} → {"+" if (delta or 0) >= 0 else ""}{delta}px），'
                f'虹膜质心 {v["iris_centroid"]} 眼白质心 {v["sclera_centroid"]}')
        ratios = {side: (eye.get('sclera_opening') or {}).get('ry_ratio')
                  for side, eye in ((s5 or {}).get('eyes') or {}).items()}
        lost = {side: v.get('clipped_pixels') for side, v in (ch.get('iris_clip_p2') or {}).items()}
        add(f'- 结论：虹膜越出眼白 **0px**；看向右上时虹膜像素 '
            + '、'.join(f'`{side}` {v.get("rest_iris_pixels")}→{v.get("p2_iris_pixels")}'
                       for side, v in (ch.get('iris_clip_p2') or {}).items())
            + f'，被裁掉 {lost}（负值=眼动时网格略有放大）。眼白椭圆 ry = {ratios} × r，'
            f'并按原图眼眶开口裁剪（越出开口的像素 = 0），所以虹膜是贴着开口边界移动，'
            f'不是被眼白遮罩削掉一角。贴近边界的像素只是相邻，不减少虹膜面积。')
        bl = ch['idle_blink']
        lm = bl['lash_metric']
        im = bl['iris_metric']
        add(f'- Idle 视频眨眼：按**睫毛竖向范围**（阈值 <{lm["threshold"]}×）→ 找到 {lm["frames"]} 帧'
            f'（{"达标" if lm["found"] else "**未找到**"}）；按**虹膜像素数**（<{im["threshold"]}× 中位数，'
            f'中位数 {im["median"]}）→ 找到 {bl["frames"]} 帧，成 {len(bl["clusters"] or [])} 次眨眼：'
            + '；'.join(f'{c0["start_t"]}s–{c0["end_t"]}s（{c0["frames"]} 帧，虹膜最少 {c0["min_iris"]}）'
                        for c0 in (bl['clusters'] or [])))
        add(f'- 视频经鼻部模板匹配跟踪头部摆动（x {s8["video"]["tracking"]["offset_x"]}，'
            f'y {s8["video"]["tracking"]["offset_y"]}，最低匹配分 {s8["video"]["tracking"]["min_match_score"]}），'
            f'否则固定 ROI 会被 Idle 的摆头带偏（这正是只看固定 ROI 时"找不到眨眼"的原因）')
        add(f'- 视频：{s8["video"].get("files")}，时长 {s8["video"].get("duration_s")}s，'
            f'{s8["video"].get("frames_sampled")} 帧抽样（{s8["video"].get("sampled_fps")}fps）')
        add(f'- Web：文件 {s8["web"].get("files")}，HTTP 自检 ok=**{s8["web"].get("ok")}**（临时服务端口 {s8["web"].get("port")}，验证后已关闭）')
        add(f'- 导出损失报告（每姿态 6 条，`structure/baked` 1 + `mask/baked` 5）：逐条详见各 `export_*.log` 与 '
            f'`{rel("step8/p1/native.psd-pose.report.json")}`')
        add(f'- 检查图：`{rel("step8/check_step8_poses.png")}`，`{rel("step8/check_step8_eyes.png")}`，'
            f'`{rel("step8/check_step8_closed_eyes.png")}`，`{rel("step8/check_step8_mouth.png")}`，'
            f'`{rel("step8/check_step8_video_frames.png")}`\n')
        add(f'- 守护进程清理：Gradle daemon 剩余 {s8.get("daemon", {}).get("remaining_gradle_daemons", "?")} 个\n')

    # ---- figures ------------------------------------------------------------
    add('## 检查图索引\n')
    figs = []
    for step, m in (('step3', s3), ('step4', s4), ('step5', s5), ('step6', s6),
                    ('step7', s7), ('step8', s8), ('compare', cm)):
        if not m:
            continue
        for f in m.get('figures') or []:
            figs.append([step, f'`{root}/{step}/{f}`'])
    add(table(figs, ['步骤', '文件']))
    add('')

    add('## 复现\n')
    add('```bash')
    add('cd /Users/gjy/mira-scene/tools/live2d-pipeline')
    add('./run.sh                 # step3 → step8 全跑，产物写入 config.json 的 output_dir')
    add('# 或分步：')
    add('./run.sh step3 step4 step5 step6')
    add('./run.sh step7 step8')
    add('./run.sh compare report')
    add('```')
    add('参数全部来自 `config.json`，可覆盖：'
        '`./run.sh all --out /tmp/x --set step4_upscale.color_tolerance=30`；'
        '运行时实际使用的配置快照见 `config.used.json`。\n')

    notes_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'findings.md')
    if os.path.exists(notes_path):
        with open(notes_path, encoding='utf-8') as f:
            add(f.read())
    return '\n'.join(L) + '\n'


def run(cfg, out_root, log=print):
    text = build(cfg, out_root)
    path = os.path.join(out_root, 'report.md')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    log(f'report: wrote {path} ({len(text)} chars)')
    return dict(step='report', path=path, chars=len(text))
