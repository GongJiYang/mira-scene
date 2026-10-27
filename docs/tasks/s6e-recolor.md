# S6e 任务说明：忧奈「换配色」离线工具（换服装第一步，D41）

> 用户 2026-10-27 授权「能并行的一起派发，Claude 审核」。关卡 1–5 由 Claude 裁定（见 §0），记入 decisions.md D42。
> **在独立 worktree 里执行**：`/Users/gjy/mira-wt-s6e`（分支 `s6e-recolor`，基于 9555a76）。主目录 `/Users/gjy/mira-scene` 正在跑 S6b，**不许碰主目录**。

## 铁律
1. 冲突时停下写进报告；不许改需求或绕过。
2. 不准 commit。不读 `.env`。
3. 模型源目录 `/Users/gjy/tools/models/yuna/...` **只读**。
4. 不改 `skills/live2d-auto/*`、`tools/live2d-pipeline/*`；**不改** `apps/client/src/render/live2d/cubism/yunaRenderer.ts`、`yunaParams.ts`、`preview/**`（S6b 正在改相关文件，运行时切换留到之后）。

## §0 关卡结论（Claude 裁定）
| 关卡 | 结论 |
|---|---|
| YAGNI | 只做离线工具：按「衣服图块蒙版」对贴图做色相/饱和度变换，产出配色变体贴图。**不做**：运行时切换、AI 重绘花纹、换款式（网格固定，做不到） |
| 端口/适配器 | 工具读 moc3（用仓库里的 Cubism Core 5.1.0 在 Node 里运行）和贴图，写出变体；产物是纯静态文件，以后由角色包的 `palettes` 字段引用 |
| 函数式核心 | 纯函数：`selectClothingDrawables(drawables, parts, rules)`、`rasterizeTriangles(uvs, indices, w, h) → mask`、`recolorPixel(rgba, transform)`（RGB↔HSL，保持亮度和 alpha）、`applyMasked(texture, mask, transform)`。I/O（读 moc3、读写 PNG）只在 CLI 外壳 |
| 契约 | **alpha 通道逐像素不变**、蒙版外的像素逐像素不变（属性测试 + 对真实贴图的断言）；配色规则文件非法 → 报错退出 |
| 测试奖杯 | 单测纯函数（fast-check：任意像素与变换，alpha 不变、亮度变化 ≤ 给定容差）；集成：跑一遍真实模型，生成变体并核对上面两条不变量 |

## §1 识别衣服图块
- 用 Cubism Core（`apps/client/public/vendor/cubism/live2dcubismcore.min.js`，在 Node 里用 `vm` 或 `globalThis` 方式加载）`Model.fromMoc` 读取：每个 drawable 的 `textureIndices`、`vertexUvs`、`indices`、`parentPartIndices`，以及 parts 的 id。
- 用 `apps/client/public/models/yuna/yuna.cdi3.json` 的 Parts 中文名把 part 映射到类别。规则写在 `tools/yuna-assets/palette/rules.json`：
  - `clothing`：名字含 衣、裙、领、袖、蝴蝶结、荷叶、飘带、丝带、袜、鞋、围裙、腰带、发带、头饰 的 part（以及它们的子 part）。
  - **排除**：脸、眼、眉、嘴、头发、发、皮肤、手、耳、尾、水印（`Param1`–`Param10` 相关）。
  - 先打印匹配结果清单（part id | 中文名 | 类别 | drawable 数）到报告里，供 Claude 审核，规则可调。
- 把属于 `clothing` 的三角形按 UV 光栅化到对应贴图尺寸的蒙版（2048），边缘做 1px 膨胀，避免接缝。

## §2 配色变体
- `tools/yuna-assets/palette/palettes.json` 定义变体，每个变体是一组色相区间映射（例：原紫色 260–300° → 目标色相，饱和度系数，亮度偏移 ≤ ±0.05）。先给 3 个：
  - `sakura`：紫 → 樱粉（约 340°），黑色部分保持；
  - `mint`：紫 → 薄荷绿（约 160°）；
  - `mono`：紫 → 去饱和灰白（饱和度 × 0.15）。
- 只变换蒙版内、且色相落在区间内的像素；黑白灰（低饱和度）像素不动，保证黑色裙子仍是黑色。
- 输出：`apps/client/public/models/yuna/palettes/<name>/texture_0X.png`，以及一张对比预览 `tools/yuna-assets/palette/out/preview-<name>.png`（原图和变体左右并排，缩到 1024 宽）。

## §3 CLI
`pnpm --filter … exec tsx tools/yuna-assets/palette/build.ts [--palette sakura]`（或在根 package.json 加 `assets:palettes`）。可重复运行，输出目录先清空再写。

## §4 测试与验收
`pnpm install` 后：`pnpm test`、`pnpm typecheck` 通过（本批不需要 e2e）。另外用预览页**之外**的方式验证：写一个小脚本把变体贴图渲染成一张静态合成图？——**不需要**，Claude 会在 S6b 合并后接进预览页肉眼验收。

## §5 报告
写在 `docs/tasks/s6e-recolor-report.md`：part 匹配清单、三个变体的规则、变体文件大小、两条不变量的核对结果、遇到的歧义。
