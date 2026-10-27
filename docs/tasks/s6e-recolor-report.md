# S6e 报告：忧奈「换配色」离线工具（D41）

> 执行位置：worktree `/Users/gjy/mira-wt-s6e`（分支 `s6e-recolor`，基于 9555a76）。未 commit（铁律 2）。未读 `.env`。未碰主目录 `/Users/gjy/mira-scene`。模型源目录 `/Users/gjy/tools/models/yuna/...` 全程只读。未改 `skills/live2d-auto/*`、`tools/live2d-pipeline/*`、`apps/client/src/render/live2d/**`。
>
> 接续说明：本任务由前一会话做了一部分（`tools/yuna-assets/palette/src/*` 核心代码 + sakura 一个变体），因用量限制中断。本会话从已有产出继续：修规则 → 生成 mint/mono → 补测试 → 验证。核心代码结构未推倒重来，只改动了 `pure.ts` 的继承语义与 `core.ts` 的类型兼容。

## 1. Part 匹配清单（供审核）

`tsx palette/build.ts --list` 输出（规则调整后）：

| part id | 中文名 | 类别 | 直属 drawable 数 | 命中 |
|---|---|---|---|---|
| Part2 | 刘海蝴蝶结 | clothing | 7 | include:蝴蝶结 |
| Part3 | 左侧发带 | clothing | 7 | include:发带 |
| Part6 | 右侧发带 | clothing | 7 | include:发带 |
| Part7 | 发箍 | clothing | 3 | include:发箍 |
| Part23 | 下半身 | clothing | 20 | include:下半身 |
| Part8 | 组 1 副本 | clothing | 17 | （继承：父=发箍） |
| Part9 | 组 1 | clothing | 17 | （继承：父=发箍） |
| Part26 | 躯干 | clothing | 17 | （继承：父=下半身） |
| Part25 | 鞋子 | clothing | 6 | include:鞋 |
| Part27 | 胸蝴蝶结 | clothing | 5 | include:蝴蝶结 |
| Part29 | 鞋子 | clothing | 6 | include:鞋 |
| Part / Part10 / Part12–14 / Part19–21 / Part32 | 眉毛/刘海/眼/嘴/耳/马尾 | other | — | exclude 或默认 |
| Part4 / Part5 / Part30 / Part31 | 左手/右手/手臂 | other | — | exclude:手 |
| Part24 / Part28 | 左腿/右腿 | other | — | exclude:腿（**显式阻断继承**，皮肤不染色） |
| Part11 / Part22 / Part33 / Part39 等 | 脸/颈/尾/表情 | other | — | exclude 或默认 |

**衣服 drawable 总数：112**（调整前只有 24，漏了裙子/躯干/发带）。

## 2. 规则调整（§1「规则可调」，偏离原规则文件的两处）

原 `rules.json` 照搬 §1 关键词清单，实测有两个问题，已调整：

1. **exclude「发」误杀「发带/发箍」**（§1 把发带列为 clothing）。改为用更具体的头发词：exclude 去掉「发」，加「马尾」「麻花辫」（「刘海」也曾误杀「刘海蝴蝶结」，已去掉，「刘海」part 靠默认 other 兜底）。
2. **「下半身」补进 include**——cdi3 里裙子/衣服主体叫「下半身」「躯干」「组 N」，没有任何 §1 关键词，纯靠关键词清单会漏掉整条裙子。已加「下半身」。

同时改了 `selectClothingDrawables` 的**继承语义**（原实现是「任一祖先 clothing 即 clothing」）：

- 新语义：从自己沿父链向上，取**最近**一个 direct 判定非 other 的节点；direct 命中 exclude 记为 `excluded`，**显式阻断继承**。
- 原因：下半身(clothing) → 左腿(exclude「腿」) → 鞋(include「鞋」) 这条链上，原语义会把腿（皮肤，tex0 上 h320 占 82%、avgL 0.86）误判为 clothing 染色。新语义下腿保持 other，鞋仍是 clothing。
- 组 1 / 组 1 副本（发箍子 part，头饰部件）→ 继承 clothing；组 2 / 组 3（麻花辫子 part，头发）→ 默认 other。组 1 拷贝/组 3/组 4（表情 psd 下，0 drawable）不影响。

## 3. 三个变体的规则（`palettes.json`）

| 变体 | 色相区间 | 目标色相 | 饱和度系数 | 亮度偏移 | minSaturation |
|---|---|---|---|---|---|
| sakura | 235–310° | 340°（樱粉） | ×0.85 | +0.03 | 0.18 |
| mint | 235–310° | 160°（薄荷绿） | ×0.75 | +0.03 | 0.18 |
| mono | 235–310° | 270° | ×0.15（≈去饱和） | 0 | 0.18 |

**偏离 §2 草案的一处**：§2 写「原紫色 260–300°」，但实测贴图紫色主峰在 h240（数值统计，未读图）；§2 例子区间是 260–300 也不含 h240，故区间取 **235–310°** 覆盖紫色系。上限 310 而非 320：皮肤粉色主峰在 h320（脸/颈 avgL 0.83 的 h320 占 95%+），310 避开皮肤，防止把肤色染进变体。低饱和（<0.18）像素不动 → 黑裙仍是黑、白边仍白。

## 4. 产物与文件大小

`pnpm assets:palettes`（根脚本，§3；等价于 `pnpm --filter @mira/yuna-assets exec tsx palette/build.ts`）。可重复运行：输出目录先清空再写；连跑两次字节数完全一致（幂等）。

| 变体 | texture_00 | texture_01 | texture_02 | texture_03 | 合计 | 改动像素 |
|---|---|---|---|---|---|---|
| sakura | 1,523,192 | 2,152,255 | 612,187 | 3,728 | 4,291,362 B | 99,426 |
| mint | 1,523,126 | 2,151,931 | 612,187 | 3,728 | 4,290,972 B | 99,426 |
| mono | 1,523,830 | 2,151,143 | 612,187 | 3,728 | 4,290,888 B | 99,093 |

产物：`apps/client/public/models/yuna/palettes/<name>/texture_0X.png`（每变体 4 张，含 64×64 的 texture_03 原样透传）。对比预览：`tools/yuna-assets/palette/out/preview-<name>.png`（原图左、变体右，1024 宽，4 张贴图按行堆叠）。

sakura/mint 改动像素数相同（同蒙版同区间），mono 略少（去饱和后部分像素落到 minSaturation 门槛下不再命中后续规则——不影响正确性）。改动集中在 tex0/tex1 的紫色衣服区；tex2 是表情差分（无 clothing drawable），tex3 是 64×64 小图，两者蒙版为空、逐字节不变。

## 5. 两条不变量的核对结果

**集成测试**（`tools/yuna-assets/test/integration.test.ts`）对真实贴图逐像素断言，**全部通过（14/14）**：

1. **alpha 逐像素不变**：3 变体 × 4 贴图，violations = 0。
2. **蒙版外像素逐像素不变**：用与构建时同一算法重建蒙版（含 1px 膨胀），蒙版外 RGB violations = 0。
3. 附加断言：每变体改动像素 > 1000（紫色衣服确实被换色），三变体分别为 99,426 / 99,426 / 99,093。

**单测**（`test/pure.test.ts`，fast-check 属性测试）：

- 任意像素 × 任意规则：alpha 不变；亮度变化 ≤ 0.05 + 3/255 量化容差；不命中规则原样返回；低饱和（黑白灰）像素不动。
- `hueInRange` 环绕区间判定；`applyMasked` 蒙版外逐字节不变且不修改入参；`dilateMask` 只增不减；`rasterizeTriangles` 覆盖断言；`selectClothingDrawables` 的 exclude 阻断继承语义 + 任意 part 树上「exclude 命中永不归 clothing」属性。

**typecheck**：`pnpm typecheck` 全仓 5 个包全通过。

## 6. 测试运行中的异常（已按约定停下记录，未无限重试）

`pnpm test`（全仓 561 个测试）：`apps/server/test/director.property.test.ts` 的「500 次 × 50–200 beat」属性测试在**全量跑时两次超时**（vitest 默认 5000ms，单独跑耗时 4112–4173ms 贴边，全量并行时机器负载高即爆）。

- 该测试自 S5（1d22b6b）起未改动，本分支也没碰 `apps/server/**`——**预存 flaky，与 S6e 无关**。
- 单独跑：3/3 通过。其余 560 个测试（含 yuna-assets 新增 14 个）全通过。
- 处置：未修改该测试（改 `apps/server` 超出本任务范围）。建议后续把该测试 timeout 调大或把 `RUNS` 调小，留待 D42 裁定。

## 7. 遇到的歧义与判断

1. **紫发 vs 紫衣色相重叠**：该角色头发本身就是紫色（h240–260，刘海/麻花辫贴图统计），与衣服紫色同区间。区分靠的是**蒙版**（三角形 UV 只盖 clothing drawable 的纹理区）而非色相。发带/发箍蒙版内含少量 h240 像素（发带区域占 16.7%）——判断为带子装饰色或 UV 展开时邻近texel，接受染色；若 S6b 预览发现发饰下的头发变色，再回来收窄这些 part 的蒙版。
2. **「刘海蝴蝶结」归 clothing**：名字含「刘海」但语义是蝴蝶结头饰，exclude「刘海」会误杀，已移除该关键词；「刘海」part 本身无关键词、默认 other，不受影响。
3. **颈部（Part22）含领子纹理**（tex1 h240 占 16%）：名字无「领」字，归 other 未染色。脖子皮肤（tex0 h320 95.8%）不应染色，而蒙版无法把领子从脖子纹理里剥开，**选择不动颈部**——领口紫色会保持原色。若预览看着突兀，需在 part 级更细的规则（如按 drawable 级筛选），留给 S6b 验收时裁定。
4. **debug 脚手架清理**：前一会话留下 17 个 `debug-*.ts` 一次性脚本，类型错误挡住 typecheck，且非交付物，已删除（它们产出的 `out/debug-*.png` 调试图保留未动）。我为分析新增了 `debug-analyze-parts.ts`/`debug-tree.ts`，完成使命后一并删除；分析结论（色相分布表）已记录在本报告 §1/§3。
5. **texture_03 处理**：64×64 小图（高光是灰像素，蒙版为空），所有变体里与原图逐字节一致（3,728 B 相同）——符合不变量。

## 8. 交付清单

- 工具：`tools/yuna-assets/palette/{build.ts, rules.json, palettes.json, src/{build,cli,compose,core,model,png,preview,pure,schema}.ts}`
- 测试：`tools/yuna-assets/test/{pure,integration}.test.ts`（14 个，全过）
- 产物：`apps/client/public/models/yuna/palettes/{sakura,mint,mono}/texture_0{0..3}.png` + `tools/yuna-assets/palette/out/preview-{sakura,mint,mono}.png`
- 根脚本：`pnpm assets:palettes`
- `pnpm typecheck` 全绿；`pnpm test` 560/561 通过（1 个预存 flaky，见 §6）。

## Claude 验收补记（2026-10-27）
- **肉眼验收**（集成测试用同一套蒙版算法核对，无法发现「蒙版本身框错」，所以必须看图）：在预览页用 Playwright 拦截贴图请求换成变体贴图渲染整只角色，**不改代码**。结果：蝴蝶结、裙子十字与系带、鞋子正确换色；头发紫色挑染、脸、皮肤、饮料罐未被误伤；Live2D 动画不受影响。
- **已知问题（后续优化）**：胸前领结与颈部同属 Part22，整块排除后领结在三个变体里都保持紫色，与其它已换色部件不协调。后续把规则细化到 drawable 级（按 drawable id 单独 include）。
- 运行时切换配色（角色包 `palettes` 字段 + 渲染器换贴图）留到 S6b 合并之后。
