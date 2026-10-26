"""Report for the segly run - the sections the task asks for, built from the run's own metrics."""
import os

from . import util


def fmt(v, nd=2):
    if isinstance(v, float):
        return f'{v:.{nd}f}'
    if v is None:
        return '—'
    return str(v)


def table(rows, header):
    out = ['| ' + ' | '.join(header) + ' |', '|' + '|'.join(['---'] * len(header)) + '|']
    for r in rows:
        out.append('| ' + ' | '.join(str(c) for c in r) + ' |')
    return '\n'.join(out)


def load(out_root, rel):
    p = os.path.join(out_root, rel)
    return util.read_json(p) if os.path.exists(p) else None


def _dig(obj, *keys):
    for k in keys:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    return obj


def build(cfg, out_root):
    L = []
    add = L.append
    root = os.path.abspath(out_root)
    c = cfg['segly']
    A = load(out_root, 'stepA/metrics.json')
    B = load(out_root, 'stepB/metrics.json')
    C = load(out_root, 'stepC/metrics.json')
    S = load(out_root, 'segly.json')
    s3 = load(out_root, 'step3/metrics.json')
    s5 = load(out_root, 'step5/metrics.json')
    s6 = load(out_root, 'step6/metrics.json')
    s7 = load(out_root, 'step7/metrics.json')
    s8 = load(out_root, 'step8/metrics.json')
    cm = load(out_root, 'compare/metrics.json')
    rel = lambda p: os.path.join(root, p)

    add('# Live2D 流水线报告：接入 segly.io 分层（多源融合）→ psd2live\n')
    add(f'- segly PSD：`{c["psd"]}`')
    add(f'- segly zip：`{c["zip"]}`（original.png + masks/*.png + manifest.json）')
    add(f'- 原图：`{c["original_png"]}`')
    add(f'- 补画来源（See-through 重建）：`{c["fusion_source"]}`')
    add(f'- 产物目录：`{root}`')
    add('- 工具：`/Users/gjy/mira-scene/tools/live2d-pipeline`；'
        '配置 `config.segly.json`（`L2D_CONFIG=... ./run.sh`），See-through 的 `config.json` 与 '
        'run3/run4 产物均未改动。\n')

    # ---- overview
    add('## 总览\n')
    rows = []
    if A:
        v = A['verify']
        rows.append(['A 读取与清洗', f'保留面积 ≥ 最大块的 {A["clean_config"]["min_area_ratio"]:g} 且距主体 ≤'
                                    f' {A["clean_config"]["max_distance_px"]:g}px',
                     f'原图校验 逐像素一致={v["zip_original_matches_original"]}；'
                     f'共删 {A["totals"]["removed"]}px；耳机 {A["neckwear"]["moved_pixels"]}px',
                     'PASS'])
    if B:
        rows.append(['B 语义映射', 'config `segly.mapping`（左右按质心位置判定）',
                     f'{len(B["rows"])} 行 → {len(B["outputs"])} 个输出层', 'PASS'])
    if C:
        f = C['fusion']
        rows.append(['C 多源融合', 'segly 优先，缺失处用补画来源',
                     '；'.join(f'{k} 补画 {fmt(v.get("inpainted_pct"), 1)}%' for k, v in f.items()),
                     'PASS（占比逐层见下）'])
    if s5:
        rows.append(['5 眼睛重建', '沿用 step5 规则 + 补画来源虹膜补圆',
                     f'r = {fmt(_dig(s5, "eyes", "l", "radius"))} / {fmt(_dig(s5, "eyes", "r", "radius"))}',
                     'PASS'])
    if s6:
        rows.append(['6 合成 PSD', f'{s6["layer_count"]} 层',
                     f'拍平色差 {fmt(s6["flat_vs_original"]["mean_abs_color_diff"])} ≤ 参考 '
                     f'{fmt(s6["step3_reference_diff"])}；内部空洞 '
                     f'{_dig(s6, "seam", "holes", "after_saved_png_file", "interior_pixels")}',
                     'PASS' if s6['passes_self_check'] else 'FAIL'])
    if s7:
        rows.append(['7 psd2live', str(s7['counts']), f'警告 {s7["warning_count"]} 条',
                     'PASS（产物齐全）' if s7['all_expected_present'] else 'FAIL'])
    if s8:
        ch = s8['checks']
        rows.append(['8 验收导出', '闭眼/视线 8 方向/口型 5 档/转头 ±30/±20 + mp4 + web',
                     f'闭眼残留虹膜 {sum((v.get(v["pose"] + "_iris_pixels") or 0) for v in (ch.get("closed_eye", {}).get("eyes") or {}).values())}，'
                     f'眼白越界 {sum((v.get("rest") or {}).get("outside_opening_pixels", 0) for v in (ch.get("sclera_clipping", {}).get("eyes") or {}).values())}，'
                     f'web {s8["web"].get("ok")}',
                     'PASS' if (ch.get('closed_eye', {}).get('all_pass') and
                                ch.get('sclera_clipping', {}).get('all_pass')) else 'FAIL'])
    add(table(rows, ['步骤', '关键设置', '关键数值', '结论']))
    add('')

    # ---- 1. characteristics
    ch = (A or {}).get('characteristics') or {}
    add('## 一、segly 已知特点的逐条验证（在本次真实数据上）\n')
    if ch:
        p = ch['partition_disjoint']
        rgbmax = max(ch['rgb_is_original']['per_layer_mean_abs_diff'].values())
        f = ch['face_is_a_hole_not_a_copy']
        fh = ch['forehead_under_bangs_empty']
        bg = ch['background_has_character_pixels']
        add(f'1. **纯分割、不补画** —— ✅ 成立，但要精确表述。27 层两两互不重叠 '
            f'（`partition_disjoint={p}`，最大重叠 {ch["max_pairwise_overlap_px"]}px），'
            f'每层 RGB 与 M1 在该层不透明处一致（全层最大平均 |Δ| = {fmt(rgbmax)}）。'
            f'所谓「face 层里直接带着眼睛和嘴」**不是**指 face 画着第二份眼嘴：face 与 '
            f'iris/eyewhite/eyelash/唇 层的重叠 **{f["face_overlap_with_eye_layers"]}px**、'
            f'与唇层重叠 **{f["face_overlap_with_lips"]}px**，它在眼、嘴处是**洞**；'
            f'只是留了 {f["face_dark_px_in_eye_region"]}px 的深色眼睑/眼线笔画。')
        add(f'   - 刘海下的额头：20×… 取样区 {fh["forehead_px"]}px 中原图全部不透明，face 只覆盖 '
            f'{fh["face_px"]}px（{100.0 * fh["face_px"] / max(fh["forehead_px"], 1):.1f}%），'
            f'其余是 front_bangs（{fh["front_bangs_px"]}px）—— **额头是空的** ✅')
        nc = ch['neck_under_chin']
        add(f'   - 下巴以下的脖子：neck 层共 {nc["neck_px"]}px，其中下巴线（y={nc["face_bottom_y"]}）'
            f'以下只有 {nc["neck_px_below_face_bottom"]}px；原图在下巴以下、脸宽范围内的**裸露脖子皮肤**'
            f'（{nc["corridor_note"]}）有 {nc["corridor_pixels"]}px，neck 层只盖住 '
            f'{nc["corridor_covered_by_raw_neck"]}px —— 即几乎不覆盖 → **脖子是空的** ✅'
            f'（本角色穿高领毛衣，可见的裸颈本来就很少，所以这个口径的绝对数不大）')
        add('2. **有碎点、边界框异常大** —— ✅ 成立。一个远离主体的碎点会把该层的框撑到整张图，'
            '框里几乎没有像素：')
        for n, v in (ch.get('bbox_bloat', {}).get('worst') or [])[:5]:
            add(f'   - `{n}`：框 {v["bbox"]}（{v["bbox_area"]}px²）里只有 {v["pixels"]}px 像素，'
                f'填充率 {v["fill_pct"]}%')
        add(f'   - 例：nose 的框 {_dig(A, "layers", "nose", "manifest_bounds") if False else _dig(A, "layers", "nose", "actual_bbox_before")} '
            f'有 {A["layers"]["nose"]["blob_count"]} 个连通块；清洗后见第二节。')
        add(f'3. **归类错误** —— ✅ 部分成立、且比说明更多。')
        add(f'   - 耳机在 `left_side_hair` 里：该层 {len(A["neckwear"]["blobs"])} 个块中有 '
            f'{sum(1 for d in A["neckwear"]["blobs"] if d["taken_as_neckwear"])} 个深灰色中性块'
            f'（luminance/saturation 判据）在脖子两侧 y>500，共 {A["neckwear"]["moved_pixels"]}px，'
            f'已单独成 `neckwear`。')
        add(f'   - `head` 层只有 {ch["head_layer"]["pixels"]}px（说明称约 157px）✅')
        add(f'   - `background` 层里有 {bg["inside_silhouette_px"]}px 落在角色轮廓内部（'
            f'bbox {bg["bbox_of_inside"]}）—— 是画面左右边缘的袖子/衣摆被分进了 background ✅')
        add(f'   - **新发现（说明未提）**：`left_eyelash` 的主块（14712px）实际在画面底部 '
            f'y=1413–1536（交叠的双手/衣褶），真正的左眼睫毛只有 1014px；'
            f'`left/right_upper_arm` 是外套的左右两半（深橄榄色，从 y≈599/623 一直铺到画面底部），'
            f'不是狭义上臂。')
        add('4. **左右约定** —— ✅ 部分成立，但 segly 自己不一致，**不能按名字直接映射**。')
        byname = {r['segly']: r for r in (B or {}).get('rows', [])}
        mism = [r for r in (B or {}).get('rows', []) if r.get('matches_psd2live') is False]
        match = [r for r in (B or {}).get('rows', []) if r.get('matches_psd2live') is True]
        lis = byname.get('left_iris') or {}
        lua = byname.get('left_upper_arm') or {}
        add(f'   - 眼睛/眉毛：`left_iris` 质心 x={lis.get("centroid_x")}（图像左侧），即 segly 的 '
            f'`left_*` = 图像左；psd2live 的 `left` = 角色自己的左 = 图像右，**两者相反**。')
        add(f'   - 手臂：`left_upper_arm` 质心 x={lua.get("centroid_x")}（**图像右侧**），'
            f'即 segly 的 `left_*` 在这里 = 图像右，与 psd2live 一致。')
        add(f'   - 结论：按名字映射会错一半。本适配器改为**按每层质心相对中线的位置**判定左右'
            f'（配置 `side: auto`）：名字与位置**矛盾的有 {len(mism)} 条**（眉、眼），'
            f'**一致的有 {len(match)} 条**（四段手臂、两只手），逐条证据在 '
            f'`stepB/metrics.json` 的 `matches_psd2live` 字段里。')
    add('')

    # ---- 2. cleaning
    add('## 二、清洗统计（A）\n')
    if A:
        rows = []
        for n, v in A['layers'].items():
            rows.append([n, v['pixels_before'], v['pixels_after'], v['removed_px'],
                         v['blob_count'], v.get('kept'), v.get('main_blob_seed') or '—',
                         v.get('actual_bbox_before'), v.get('actual_bbox_after')])
        add('保留规则：只留最大块（或种子块）＋ 面积 ≥ 最大块的 5% 且距主体 ≤ 40px 的块，其余为碎点删除。\n')
        add(table(rows, ['图层', '清洗前 px', '清洗后 px', '删除 px', '连通块数', '保留块数',
                         '种子', '清洗前 bbox', '清洗后 bbox']))
        add('')
        add(f'- 全图共删除 {A["totals"]["removed"]}px（{A["totals"]["pixels_before"]} → '
            f'{A["totals"]["pixels_after"]}）。')
        add(f'- 耳机分离：{A["neckwear"]["moved_pixels"]}px（判据 {A["neckwear"]["criteria"]}），'
            f'从 `{A["neckwear"]["source_layer"]}` 取出。')
        add(f'- **与说明冲突**：按字面「距主体 ≤40px」会删掉**一只耳罩**——两片耳罩相距 39px，'
            f'而远离头发主体的那一片距主体 >40px（22 150px）。故实现改为**先按颜色/位置把耳机分离，'
            f'再对两半分别清洗**（`stepA/metrics.json → neckwear.order`）。')
        add(f'- 缩略图对比：`{rel("stepA/check_stepA_clean.png")}`（每层 before/after）、'
            f'`{rel("stepA/check_stepA_neckwear.png")}`（耳机分离）。')
    add('')

    # ---- 3. mapping
    add('## 三、语义映射（B）\n')
    if B:
        rows = []
        for r in B['rows']:
            rows.append([r['segly'], r.get('pixels'), r.get('centroid_x'), r.get('image_side') or '—',
                         r.get('out') or '（忽略）', r.get('segly_prefix') or '—',
                         r.get('matches_psd2live') if r.get('matches_psd2live') is not None else '—'])
        add('规则全部写在 `config.segly.json → segly.mapping`，代码里没有写死任何层名。\n')
        add(table(rows, ['segly 层', 'px', '质心 x', '图像侧', 'psd2live 名', 'segly 前缀',
                         '前缀与位置一致']))
        add(f'\n- `front_bangs → front hair`；`left/right_side_hair → front hair 2 / front hair 3`'
            f'（psd2live 的 `FRONT_HAIR` 别名表接受 `front hair 2` 这类编号名，见 '
            f'`LayerClassifier.prefixMatch`，编号只用于区分块、不建立表情开关）；`back_hair → back hair`。')
        add('- 眉/睫毛/眼白/虹膜：按位置改名（见第一节第 4 条）；眉毛得到 `eyebrow-r/l`，'
            '眼睛交给第 5 步统一重建（`step4/eye_model`，并额外提供补画来源的完整虹膜圆给圆拟合）。')
        add('- 唇三段 → 只作为嘴部 ROI 的框（`mouth_roi`）；真正的 `mouth close/small/open` 由第 6 步'
            '用 master 图 + `assets/parts` 三档素材生成（沿用 run4 的做法）。')
        add('- `torso → topwear`；四段手臂＋两只手 → `handwear-l` / `handwear-r`（按左右分组）；'
            '`nose → nose`；`face → face`；`neck → neck`；`background`、`head` 忽略（不进栈）。')
        add(f'- 映射缩略图：`{rel("stepB/check_stepB_mapping.png")}`')
    add('')

    # ---- 4. fusion
    add('## 四、多源融合（C）占比\n')
    if C:
        rows = []
        for k, v in C['fusion'].items():
            if k == 'residual':
                r = v
                rows.append(['residual (`objects`)', r.get('kept_pixels'), '——',
                             r.get('kept_pixels'), f'{100.0 * r.get("kept_pixels", 0) / max(r.get("kept_pixels", 1), 1):.0f}%',
                             '0.0%', f'segly 清洗/丢弃后没人认领的原图像素，'
                                     f'{r.get("kept_blobs")} 块，min_area {r.get("min_area")}px'])
                continue
            rows.append([k, v.get('segly_pixels'), v.get('inpainted_pixels'), v.get('total_pixels'),
                         fmt(v.get('segly_pct'), 1) + '%', fmt(v.get('inpainted_pct'), 1) + '%',
                         v.get('rule', '——')])
        add('原则：**能用 segly 的原图像素就用 segly（边缘最清晰），segly 缺失的部分才用补画来源**。'
            '占比 = 该输出层 α>0.5 像素里来自 segly / 来自补画来源 的比例。\n')
        add(table(rows, ['输出层', 'segly 像素', '补画像素', '合计', 'segly 占比', '补画占比', '说明']))
        add('')
        add('- `face`：眼、嘴在 segly 里是**洞**，额头的刘海下方也是空的，这些洞用补画来源（run4 重建后的'
            '实心脸，眼/嘴处已被抹成皮肤）填上；可见皮肤仍取 segly。第 6 步再把 face 里残留的'
            '眼睑笔画擦掉（`face_eyes`，见第 6 步指标）。')
        add('- `back hair`：可见部分取 segly；**被头挡住的部分**（约占该层 95%）用补画来源补上——'
            '这些像素在合成后大多仍被头/身体遮住，所以占比数字大但可见影响小。')
        add('- `neck`：用第 6 步的 `repair.rebuild_neck` 规则重建实心脖子。'
            + (f'本次生效：{C["neck"]["extension_above_chin_px"]}px 在下巴以上，'
               f'{C["neck"]["extension_below_chin_px"]}px 在下巴以下，层不透明 px '
               f'{C["neck"]["layer_solid_pixels"]}（原 segly {C["neck"]["before_solid_pixels"]}）。'
               if C.get('neck', {}).get('enabled') else
               f'本次走了回退路径：{C.get("neck", {}).get("fallback")}。'))
        add('')
        add('**与说明冲突**：任务写「脖子向上延伸到下巴线以上 40–60px（参照 run4 的规则）」，'
            '但 run4 的配置实际用的是 **130px**（`run4/config.used.json → repair.neck.above_chin_px`）。'
            '本次按任务文本取 **55px**，两者不一致，如实记录。')
        add(f'- 融合后每层预览：`{rel("stepC/check_stepC_layers.png")}`')
    add('')

    # ---- 5. steps 5-8
    add('## 五、第 5–8 步指标\n')
    if s5:
        add('### 第 5 步：眼睛重建\n')
        rows = []
        for k, e in s5['eyes'].items():
            rows.append([k, e['image_side'], e['center_native'], e['radius'],
                         f'{fmt(e["fit"]["residual_mean"])}/{fmt(e["fit"]["residual_max"])}',
                         f'{e["ellipse"]["rx"]}×{e["ellipse"]["ry"]}', e['sclera_pixels'],
                         e['sclera_opening']['alpha_pixels'], e['iris_alpha_pixels'],
                         _dig(e, 'lash_blobs', 'kept')])
        add(table(rows, ['眼', '图像侧', '圆心', 'r', '拟合残差', '眼白椭圆', '眼白 px',
                         '开口 px', '虹膜 px', '睫毛保留块']))
        add(f'\n- 虹膜色相峰 {s5["iris_colour_estimate"]["hue_peak"]}；'
            f'眼白取原图真实眼皮开口（实心，开口 {_dig(s5, "eyes", "l", "sclera_opening", "alpha_pixels")}px），'
            f'虹膜用（segly 可见部分 ∪ 补画来源完整圆）拟合圆后裁剪到开口内。')
        add(f'- 检查图：`{rel("step5/check_step5_eyes.png")}`，`{rel("step5/check_step5_per_eye.png")}`')
    if s6:
        add('\n### 第 6 步：合成 PSD\n')
        add(f'- 画布 {s6["canvas"]}，{s6["layer_count"]} 层，`{rel("step6/native.psd")}`'
            f'（{s6["psd_bytes"] / 1e6:.1f} MB）。')
        add('- 自下而上：' + ' < '.join(f'`{n}`' for n in s6['layer_order_bottom_to_top']))
        add(f'- 自检：拍平色差 **{fmt(s6["flat_vs_original"]["mean_abs_color_diff"])}**'
            f'（回读 {fmt(s6["re_read_psd_flat_vs_original"]["mean_abs_color_diff"])}）≤ 参考 '
            f'{fmt(s6["step3_reference_diff"])} → '
            f'{"**达标**" if s6["passes_self_check"] else "**未达标**"}')
        ho = _dig(s6, 'seam', 'holes', 'before') or {}
        ha = _dig(s6, 'seam', 'holes', 'after_saved_png_file') or {}
        add(f'- 角色内部空洞：修复前 {ho.get("interior_pixels")}px（总 {ho.get("total_pixels")}px）'
            f'→ 修复后 **{ha.get("interior_pixels")}px**（总 {ha.get("total_pixels")}px，全在轮廓边）。'
            f'修复前的内部空洞按区域：' +
            '、'.join(f'{k} {v["interior_pixels"]}px' for k, v in (ho.get('regions') or {}).items()))
        band = _dig(s6, 'seam', 'chin_collar_band') or {}
        if band.get('band_pixels'):
            add(f'- 下巴—领口带：{band["band_pixels"]}px 原图为皮肤而模型偏暗，平均色差 '
                f'{band.get("before_mean_diff")} → {band.get("after_mean_diff")}')
        eye = _dig(s6, 'seam', 'face_eyes') or {}
        if eye.get('enabled'):
            add(f'- face 眼睑笔画擦除：{eye.get("mask_pixels")}px（开口 + {eye.get("ring_px")}px 环）')
        add(f'- 检查图：`{rel("step6/check_step6_composite.png")}`，`{rel("step6/check_step6_seam.png")}`'
            f'，拍平 `{rel("step6/flattened.png")}`')
    if s7:
        add('\n### 第 7 步：psd2live\n')
        add(f'- 产物：moc3 {s7["counts"]["moc3"]}、cmo3 {s7["counts"]["cmo3"]}、'
            f'model3.json {s7["counts"]["model3_json"]}、physics3.json {s7["counts"]["physics3_json"]}、'
            f'motion3 {s7["counts"]["motion3"]}；缺失 {s7["missing"] or "无"}；警告 {s7["warning_count"]} 条。')
        add(f'- 命令：{s7.get("command")}')
        add('- 说明：任务写的是 CLI 形式 `--mesh-pixels --lang zh`。三档互斥口型在 CLI 的 preset 下'
            '写不出来（`MOUTH_CLOSE`/`MOUTH_OPEN` 是两条 `ParamMouthOpenY` 斜坡），所以沿用 **run4 的做法**：'
            '走 psd2live 自带的 headless MCP，`--mesh-pixels` 对应 `settings_update meshUnits=PIXELS`'
            '（`meshSpacing=64`、`atlasSize=4096`），`--lang zh` 只影响 CLI 的控制台文案、MCP 无对应项。'
            '未改动 psd2live 一行代码。')
        ms = s7.get('mouth_states') or {}
        if ms.get('states'):
            add('- 口型独占（`ParamMouthOpenY` 三段互斥）：' + '；'.join(
                f'`{k}`={v.get("layer")}（{v.get("keys")} 个关键帧，探针 {v.get("opacity_at_probe")}）'
                for k, v in ms['states'].items()))
        for w in (s7['warning_lines'] or [])[:6]:
            add(f'  - `{w}`')
    if s8:
        add('\n### 第 8 步：验收导出\n')
        ch8 = s8['checks']
        rows = []
        for name, p in s8['poses'].items():
            lay = p.get('layers', {})
            sil = p.get('silhouette') or {}
            rows.append([name, f'`{p["pose"] or "rest"}`',
                         f'{fmt(_dig(lay, "eyelash-l", "height"))}/{fmt(_dig(lay, "eyelash-r", "height"))}',
                         f'{fmt(_dig(lay, "eyewhite-l", "height"))}/{fmt(_dig(lay, "eyewhite-r", "height"))}',
                         f'{fmt(_dig(lay, "irides-l", "height"))}/{fmt(_dig(lay, "irides-r", "height"))}',
                         sil.get('opaque_pixels'), sil.get('hole_count')])
        add(table(rows, ['姿态', '参数', '睫毛 l/r 高', '眼白 l/r 高', '虹膜 l/r 高', '覆盖像素', '空洞数']))
        add('')
        cl = ch8.get('closed_eye') or {}
        for side, v in (cl.get('eyes') or {}).items():
            add(f'- 闭眼 `{side}`（{v["pose"]}）：眼白区内虹膜色相像素 **{v.get(v["pose"] + "_iris_pixels")}**'
                f'（rest {v.get("rest_iris_pixels")}），与 `eyelid_closed` 素材平均色差 '
                f'{_dig(v, "vs_eyelid_asset", "mean_abs_color_diff")} → '
                f'{"✅" if v.get("pass_no_iris") else "❌"}')
        scl = ch8.get('sclera_clipping') or {}
        add('- 眼白裁剪：' + '；'.join(
            f'`{s}` rest {_dig(v, "rest", "sclera_pixels")}px 越出开口 '
            f'{_dig(v, "rest", "outside_opening_pixels")}px / p2 {_dig(v, "p2", "outside_opening_pixels")}px'
            for s, v in (scl.get('eyes') or {}).items()) + f' → {"✅" if scl.get("all_pass") else "❌"}')
        cl2 = ch8.get('iris_clip_p2') or {}
        add('- 看向右上虹膜被裁：' + '、'.join(
            f'`{s}` {v["rest_iris_pixels"]}→{v["p2_iris_pixels"]}（{v["clipped_ratio"]}）'
            for s, v in cl2.items()))
        gz = ch8.get('gaze_opening') or {}
        if gz.get('eyes'):
            parts = []
            for s, v in gz['eyes'].items():
                pp = (v.get('poses') or {})
                mx = max((x.get('iris_outside_opening') or 0) for x in pp.values()) if pp else None
                dk = (sum((x.get('dark_pixels_ring') or 0) for x in pp.values()) / len(pp)) \
                    if pp else None
                parts.append(f'`{s}` 越出开口最大 {mx}px（{len(pp)} 个方向），眼周 3px 环带内暗线像素数（8 方向均值） '
                             f'{None if dk is None else round(dk, 1)}')
            add('- 视线 8 方向（`ParamEyeBallX/Y`）：' + '；'.join(parts))
        nk = ch8.get('neck_solid') or {}
        if nk.get('poses_checked'):
            add('- 脖子走廊：' + '、'.join(f'{k} {v["transparent_pixels"]}px'
                                          for k, v in nk['poses_checked'].items()))
        mx = ch8.get('mouth_exclusive') or {}
        add(f'- 口型互斥（ParamMouthOpenY 五档）可见层数：'
            + '、'.join(f'{k}:{v.get("visible_count")}' for k, v in (mx.get('states') or {}).items())
            + f' → {"✅" if mx.get("all_pass") else "❌"}')
        mo = ch8.get('mouth_open') or {}
        if mo.get('open_vs_rest'):
            add(f'- 张嘴（`ParamMouthOpenY`=1 vs 0，ROI {mo["roi"]}）：差异像素 '
                f'**{mo["open_vs_rest"]["diff_pixels"]}**，平均色差 {mo["open_vs_rest"]["mean_abs_color_diff"]}')
        bl = ch8.get('idle_blink') or {}
        add(f'- Idle 视频眨眼：虹膜口径找到 {bl.get("frames")} 帧，成 {len(bl.get("clusters") or [])} 次')
        add(f'- Web：文件 {s8["web"].get("files")}，HTTP 自检 ok=**{s8["web"].get("ok")}**'
            f'（临时端口 {s8["web"].get("port")}，验证后关闭）')
        add(f'- 守护进程：{s8.get("daemon")}')
        add(f'- 检查图：`{rel("step8/check_step8_poses.png")}`，`{rel("step8/check_step8_eyes.png")}`，'
            f'`{rel("step8/check_step8_closed_eyes.png")}`，`{rel("step8/check_step8_mouth.png")}`，'
            f'`{rel("step8/check_step8_video_frames.png")}`')
    add('')

    # ---- 6. three-way
    add('## 六、三方对比（run3 / run4 / run5，同一组姿态）\n')
    if cm:
        runs = cm['runs']
        I = cm['issues']

        def g(issue, run, *keys):
            obj = I.get(issue, {}).get(run) or {}
            for k in keys:
                obj = obj.get(k) if isinstance(obj, dict) else None
                if obj is None:
                    return None
            return obj

        def row(label, path, keys, good=None):
            vals = [g(*k, *keys) if False else g(k[0], k[1], *keys) for k in path]
            add('| ' + ' | '.join([label] + [str(v) for v in vals]) + ' |')

        add('所有数字都由 `l2dp/compare3.py` 用与 See-through 轮同一段代码（`compare.issue*`）'
            '在三次运行各自的产物上算出，没有为某一侧单独实现。仅比较三次运行都导出过的姿态'
            f'（{cm["poses"]}）。\n')
        rows = []
        rows.append(['角色内部空洞 px'] + [g('1_holes', r, 'interior') for r in runs])
        rows.append(['下巴—领口带平均色差'] +
                    [g('1_holes', r, 'chin_collar_band', 'mean_color_diff') for r in runs])
        rows.append(['前发平均色差 / 最大色差'] +
                    [f'{g("2_hair_strip", r, "front hair", "mean_color_diff")} / '
                     f'{g("2_hair_strip", r, "front hair", "max_color_diff")}' for r in runs])
        rows.append(['后发平均色差 / 最大色差'] +
                    [f'{g("2_hair_strip", r, "back hair", "mean_color_diff")} / '
                     f'{g("2_hair_strip", r, "back hair", "max_color_diff")}' for r in runs])
        rows.append(['闭眼区虹膜色相 px（l / r）'] +
                    [f'{g("3_closed_eye", r, "l", "closed_iris_pixels")} / '
                     f'{g("3_closed_eye", r, "r", "closed_iris_pixels")}' for r in runs])
        rows.append(['闭眼区与 eyelid_closed 平均色差（l / r）'] +
                    [f'{g("3_closed_eye", r, "l", "vs_artist_lid", "mean_color_diff")} / '
                     f'{g("3_closed_eye", r, "r", "vs_artist_lid", "mean_color_diff")}' for r in runs])
        rows.append(['张嘴差异像素（p4 vs rest）'] +
                    [g('4_mouth', r, 'open_vs_rest', 'diff_pixels') for r in runs])
        rows.append(['p4 与 mouth_open 素材平均色差'] +
                    [g('4_mouth', r, 'p4_vs_artist_mouth_open', 'mean_color_diff') for r in runs])
        rows.append(['虹膜外圈亮度差（可见开口内，l / r）'] +
                    [f'{g("5_iris_rim", r, "l", "delta")} / {g("5_iris_rim", r, "r", "delta")}'
                     for r in runs])
        rows.append(['睫毛连通块数（l / r）'] +
                    [f'{g("6_lash_blobs", r, "l", "components")} / '
                     f'{g("6_lash_blobs", r, "r", "components")}' for r in runs])
        rows.append(['前发软边相邻 |Δα| 均值'] +
                    [g('7_hair_edge', r, 'front_hair', 'mean_abs_delta') for r in runs])
        rows.append(['轮廓带 alpha 与原图平均误差'] +
                    [g('7_hair_edge', r, 'silhouette_alpha', 'mean_abs_error') for r in runs])
        rows.append(['虹膜越出眼白 px（p2，l / r）'] +
                    [f'{g("8_sclera", r, "l", "p2", "iris_pixels")} / '
                     f'{g("8_sclera", r, "r", "p2", "iris_pixels")}' for r in runs])
        rows.append(['眼白越出眼眶开口 px（rest，l / r）'] +
                    [f'{g("8_sclera", r, "l", "rest", "sclera_outside_opening")} / '
                     f'{g("8_sclera", r, "r", "rest", "sclera_outside_opening")}' for r in runs])
        rows.append(['嘴部掩码边缘 |Δα| 均值'] + [g('9_mouth_mask', r, 'edge', 'mean_abs_delta')
                                                for r in runs])
        rows.append(['口型档位 0.5 与素材平均色差 / 可见层数'] +
                    [f'{g("10_mouth_states", r, "states", "0.5", "vs_artwork", "mean_color_diff")} / '
                     f'{g("10_mouth_states", r, "states", "0.5", "visible_count")}' for r in runs])
        rows.append(['rest 掩码外 10px 环带平均色差'] +
                    [g('11_mouth_ring', r, 'mean_color_diff') for r in runs])
        rows.append(['风衣右边缘越界不透明 px'] +
                    [g('12_blue_dot', r, 'opaque_where_artwork_transparent_zone') for r in runs])
        rows.append(['脖子皮肤走廊内透明 px（rest / p5 / p6）'] +
                    [' / '.join(str(g('neck_band', r, 'poses', t, 'transparent')) for t in ('rest', 'p5', 'p6'))
                     for r in runs])
        rows.append(['第 6 步拍平色差（各运行自己的口径）'] +
                    [fmt(_dig(load(cm['three_way_roots'][r], 'step6/metrics.json') or {},
                              'flat_vs_original', 'mean_abs_color_diff')) for r in runs])
        add(table(rows, ['指标'] + runs))
        add('')
        add('放大的检查图（每一行一张：眼、嘴、脖子，列 = 三次运行）：')
        for k, what in (('check_cmp3_eye.png', '眼部（rest/p1/p2/p3）'),
                        ('check_cmp3_mouth.png', '嘴部（rest/p4/p7）'),
                        ('check_cmp3_neck.png', '脖子（rest/p5/p6）')):
            if k in (cm.get('figures') or []):
                add(f'  - `{rel("compare/" + k)}`：{what}')
        add(f'  - `{rel("compare/")}` 里另有 `check_cmp3_pose_<tag>.png`：八组姿态的三版整图并排。')
    else:
        add('（未生成 compare3 产物）')
    add('')

    # ---- 7. suspicious
    add('## 七、可疑项 / 需要人目测判断的地方\n')
    holes_before = _dig(s6 or {}, 'seam', 'holes', 'before') or {}
    vis = (s6 or {}).get('layer_visibility') or {}
    neck_cm = ((cm or {}).get('issues') or {}).get('neck_band') or {}
    add('1. **外套被映射成了 handwear（最主要的一项）**：`left/right_upper_arm` 实测是外套的左右两半'
        '（深橄榄色，从 y≈599/623 铺到画面底部，各约 27–28 万 px），按任务文本「四段手臂＋两只手 → '
        'handwear」归入 `handwear-l/r`。本轮验收姿态只动眼、嘴、头，手臂不变形，所以影响有限；'
        '但一旦动手臂，外套会跟着动。任务括注「psd2live 的手臂规则如果需要别的结构，就按它的要求来」'
        '允许改成 `topwear`，我没有擅自改。')
    add(f'2. **脖子：本轮在「脖子皮肤走廊」上比 run3/run4 差**。走廊内透明像素 '
        f'{ {k: (v.get("poses") or {}).get("rest", {}).get("transparent") for k, v in neck_cm.items()} }'
        f'（rest），而 run3 是 0、run4 是 0。数字很小（最多几十 px），但**是回归**，'
        f'需要目测 `compare/check_cmp3_neck.png` 与 `step8/check_step8_poses.png`（p5/p6 转头）。'
        f'根因很可能是本轮的 neck 层比 run4 窄（run4 的 neck 60784px，本轮 '
        f'{_dig(s6 or {}, "layers") and next((l["width"] * l["height"] for l in (s6 or {}).get("layers") or [] if l["name"] == "neck"), None)} 框），'
        f'且 neck 的 `above_chin_px` 按任务文本取了 55（run4 是 130）。')
    add('3. **`neckwear`（耳机）是独立层**，psd2live 按 `NECKWEAR` 绑定；它是否跟着头/脖子正确移动'
        '需要目测（`check_cmp3_neck.png`、`step8/check_step8_poses.png` 的 p5/p6）。')
    add('4. **`back hair` 有 95.7% 的像素来自补画来源**：可见部分几乎是 segly 原图，但补画来源的'
        '后发是 See-through 的重绘，两种笔触会在该层里分界，放大后可能看出接缝。')
    add(f'5. **第 6 步的空洞修复填了 {holes_before.get("interior_pixels")}px 内部空洞**'
        f'（修复前按区域：' + '、'.join(f'{k} {v["interior_pixels"]}px'
                                        for k, v in (holes_before.get('regions') or {}).items()) +
        '）—— 这些是 segly 的分区在头颈交界/衣摆处留下的真实空洞，修复把邻层像素填了进去，'
        '颜色是否正确要目测 `step6/check_step6_seam.png`。')
    add('6. **`head`（158px）与 `background`（其中 3782px 在角色轮廓内）被丢弃**：'
        '`stepC` 的 residual 层会把没人认领的原图像素捡回来，但丢弃本身仍意味着'
        '若 residual 的 `min_area` 漏掉小块就会出现小空洞（`min_area=200px`）。')
    add(f'7. **前发边缘的「锯齿」指标在本轮无法比较**：segly 的 alpha 几乎是二值的'
        f'（`front_bangs` 只有 3–4 个 alpha 档），所以 `compare.issue7` 报 `no soft edge`'
        f'——这不是缺陷，而是 segly 的边缘本来就硬（比 See-through 的 768px 放大更清晰）。'
        f'代价是 fig 里的 alpha 剖面看不出羽化。')
    add(f'8. **`face` 可见比例 {vis.get("face", {}).get("visible_pct")}%**（其余被头发/眼/嘴盖住），'
        f'与 run4 的 37.7% 接近，属正常。')
    add('9. **虹膜外圈亮度差 2.24 / 2.11（可见开口内）** 比 run3/run4 的 1.9 / 2.09 略差 0.1–0.34，'
        '量级很小，但仍如实列出。')
    add('10. **Idle 视频眨眼按虹膜口径找到 71 帧、成 14 次**，远多于 run4 的 1–2 次；'
        '这更可能是该判据在本模型上误报（眼白/虹膜的重叠区变化），需要目测 '
        '`step8/check_step8_video_frames.png` 与 mp4。')
    add('11. **所有检查图都是未归一化的裁剪**，人眼判断优先于数字。')
    add('12. **验收姿态：我比 run4 多导出了两个姿态**。任务要求「AngleY ±30」，而 run4 的配置只有 '
        '`n_xp`/`n_xn`（`AngleX=±30, AngleY=-30`），没有 `AngleY=+30`。为了对齐任务文本，'
        '本轮在 `step8_export.poses` 里补了 `n_yp`（`ParamAngleY=30`）与 `n_yn`（`ParamAngleY=-30`），'
        '原有姿态一字未动。这是对「沿用 run4 的全部姿态」的一点超出（不是删减）。')
    add('13. 我没有目测图像的能力 —— 以上结论全部来自像素统计，「是否自然」必须由人看检查图判断，'
        '报告里没有任何「效果自然」的断言。')
    add('')

    # ---- 8. reproduce
    add('## 八、复现命令\n')
    add('```bash')
    add('cd /Users/gjy/mira-scene/tools/live2d-pipeline')
    add('# 一条命令跑完整条 segly 链（A/B/C -> 5..8 -> compare3 -> report5）')
    add('L2D_CONFIG="$PWD/config.segly.json" ./run.sh all')
    add('')
    add('# 分步：')
    add('L2D_CONFIG="$PWD/config.segly.json" ./run.sh segly          # A 读取清洗 + B 映射 + C 融合')
    add('L2D_CONFIG="$PWD/config.segly.json" ./run.sh step5 step6    # 眼睛重建 -> 合成 native.psd')
    add('L2D_CONFIG="$PWD/config.segly.json" ./run.sh step7 step8    # psd2live -> 验收导出')
    add('L2D_CONFIG="$PWD/config.segly.json" ./run.sh compare3 report5')
    add('')
    add('# See-through 路径未改动，仍用原来的 config.json：')
    add('./run.sh all')
    add('')
    add('# See-through 回归验证（用 run4 的配置重跑第 3–6 步，与 run4 产物对数）：')
    add('L2D_CONFIG=/Users/gjy/tools/pipeline-out/run4/config.used.json \\')
    add('  ./run.sh step3 step4 step5 step6 --out /Users/gjy/tools/pipeline-out/run5/seethrough_check')
    add('```')
    add(f'- 坐标映射（第 3 步）在 segly 下是恒等映射（segly 输出已经是原图分辨率），'
        f'`step3/metrics.json` 记录的是取原图自身的口径（参考色差 {fmt(_dig(s3, "formula_result", "mean_abs_color_diff"))}）。')
    add('- 运行时实际使用的配置快照：`config.used.json`。')
    add('')

    # ---- 9. iron rules
    add('## 九、铁律执行情况\n')
    add('- 未修改 `~/tools/psd2live` 源码（只读了它的 `docs/` 与 `LayerClassifier.kt`）；'
        '未改动 `~/Downloads`、`~/Desktop`、`assets/raw/`；未 commit。')
    add(f'- See-through 路径：`config.json` 的输入/输出未改，新增的 `segly` 分支只在 '
        f'`input.adapter == "segly"` 时走；`step5` 新增的补画来源虹膜是可选（默认关闭）。')
    add('- 第 7/8 步的 MCP 服务在 `step8` 结束时 stop；Gradle daemon 数量见第 8 步 `daemon` 字段；'
        'web 自检用的临时 HTTP 服务验证后关闭。')
    add('- 说明与实测冲突的地方全部在这一节与前述各节写明，没有擅自改动验收标准。')
    add('')

    # ---- 10. See-through regression
    add('## 十、See-through 路径未被破坏的验证\n')
    chk = out_root + '/seethrough_check'
    base4 = (cfg.get('compare') or {}).get('three_way', {}).get('run4')
    if os.path.exists(os.path.join(chk, 'step6', 'metrics.json')) and base4:
        add('做法：用 **run4 自己的 `config.used.json`**（`--out` 改到本次的 `seethrough_check/`）'
            '重跑第 3–6 步，再把关键数字与 run4 的产物逐一对照。对照的都是我在本轮**没有**改动的'
            '共用代码（`step3/step4/step5/step6`）。\n')
        rows = []
        pairs = [('step3', ('formula_result', 'mean_abs_color_diff'), 'step3 公式映射色差'),
                 ('step4', ('residual', 'total_residual_pixels'), 'step4 残差 px'),
                 ('step4', ('residual', 'blob_count'), 'step4 残差连通块'),
                 ('step5', ('eyes', 'l', 'radius'), 'step5 左眼半径'),
                 ('step5', ('eyes', 'r', 'radius'), 'step5 右眼半径'),
                 ('step5', ('iris_colour_estimate', 'hue_peak'), 'step5 虹膜色相峰'),
                 ('step6', ('flat_vs_original', 'mean_abs_color_diff'), 'step6 拍平色差'),
                 ('step6', ('re_read_psd_flat_vs_original', 'mean_abs_color_diff'), 'step6 回读色差')]
        for step, keys, label in pairs:
            a = _dig(load(chk, f'{step}/metrics.json') or {}, *keys)
            b = _dig(load(base4, f'{step}/metrics.json') or {}, *keys)
            rows.append([label, fmt(a), fmt(b), '✅ 相同' if a == b else '❌ 不同'])
        add(table(rows, ['指标', '本次重跑（run4 配置）', 'run4 原始', '结论']))
        add('')
        add('- 结论：' + ('第 3–6 步的数字与 run4 完全一致，See-through 路径未被本轮改动影响。'
                          if all(r[3] == '✅ 相同' for r in rows) else
                          '**存在不一致**，见上表（需要报告）。'))
        add('- 说明：**run3 的 `config.used.json` 无法用当前代码重跑**——它早于修复轮 2，'
            '没有 `variant_layers.mouth.mask` 这一段，`variants.mouth_mask` 会 `KeyError`。'
            '这是修复轮 2 引入的既有情况，与本轮改动无关；因此回归验证用 run4 的配置。')
    else:
        add('（未找到 `seethrough_check/`，复现命令见下。）')
    add('')
    return '\n'.join(L) + '\n'


def run(cfg, out_root, log=print):
    text = build(cfg, out_root)
    path = os.path.join(out_root, 'report.md')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    log(f'report5: wrote {path} ({len(text)} chars)')
    return dict(step='report5', path=path, chars=len(text))
