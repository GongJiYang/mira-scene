# Live2D 流水线：接入 segly.io 分层（多源融合）→ psd2live

你是执行工程师。不要 commit，也不要改 `docs/architecture/`。只读背景：`docs/architecture/live2d-pipeline.md`、`docs/tasks/live2d-pipeline*.md`（之前几轮的任务说明），以及 `~/tools/pipeline-out/run3/report.md`、`run4/report.md`。
工具代码在 `/Users/gjy/mira-scene/tools/live2d-pipeline/` 里继续开发：**新增 segly 输入适配器，原来的 See-through 路径不能被破坏**（改完后，用 run3 的配置重跑必须得到相同结果；如果做不到，就在报告里写明原因）。本次产物输出到 `~/tools/pipeline-out/run5/`。

## 铁律
1. 不得修改 `~/tools/psd2live` 的源码，也不得修改 `~/Downloads`、`~/Desktop`、`assets/raw/` 下的任何文件。
2. 每一步都要产出检查图和 `metrics.json`，达不到标准就如实报告，**不要宣称效果自然**，效果由用户亲自目测判断。
3. 说明和实际情况冲突时，停下来报告，不得擅自改动验收标准。
4. 不要 commit，不要留下常驻进程。

## 输入
| 项 | 路径 |
|---|---|
| segly PSD | `/Users/gjy/Downloads/live2d/segmentation_50b78b36-74a9-44a1-8714-16cbcb7554e8_live2d.psd`（1024×1536，27 层） |
| segly zip | 同一目录下的 `.zip`：包含 `original.png`、`masks/*.png`、`manifest.json`（格式 `segly.io`，含 bounds、pivot、order） |
| 原图 | `/Users/gjy/Desktop/立绘图/M1 · 主立绘（透明背景）.png`（和 zip 里的 `original.png` 应该是同一张图，先校验） |
| 补画来源（See-through） | `~/tools/pipeline-out/run4/`（如果 run4 不完整就用 run3）里**已重建的原分辨率图层**：face、neck、back hair、eyewhite、irides 等，和 M1 同一块画布 |
| 画好的变体 | `/Users/gjy/mira-scene/assets/parts/`：`eyelid_closed.png`、`mouth_small.png`、`mouth_open.png`（与 M1 逐像素对齐） |

## segly 的已知特点（先逐条**验证**，再处理）
1. **纯分割，不补画**：face 层里直接带着眼睛和嘴；被刘海遮住的额头、下巴下面的脖子、头后面的后发，都是空的。
2. **有碎点**：很多层夹着零星的像素，导致边界框异常大（比如 left_eyebrow、nose、upper_lip 的边界框横跨整张图）。
3. **归类错误**：耳机被分进了 `left_side_hair`；`head` 层只有大约 157px；`background` 层里可能混进了角色像素。
4. **左右约定**：segly 的 `left_*` 推测指**图像左侧**，例如 `left_iris` 在 x≈400–445。psd2live 的 left 指**角色自己的左边，也就是图像右侧**，两者要互换。请先验证这一点。

## 步骤
### A. 读取与清洗
- 校验 `original.png` 与 M1 是否逐像素一致。
- 每一层只保留主要连通块：面积超过最大块的 5%，并且距离主体不超过 40px。其余碎点删掉，逐层报告删掉了多少像素。
- 把耳机从 `left_side_hair` 中分离出来（按颜色和位置判断，耳机是深灰色、在脖子两侧、y>500），单独成一层 `neckwear`。
- 输出清洗前后的逐层缩略图对比，以及每层的像素数、连通块数。

### B. 语义映射到 psd2live 的命名
- front_bangs → `front hair`；left_side_hair / right_side_hair → `front hair 2` / `front hair 3`，或者按 psd2live 规范确定更合适的标签，并说明理由；back_hair → `back hair`
- 眉毛 → `eyebrow-l/r`，睫毛 → `eyelash-l/r`，眼白 → `eyewhite-l/r`，虹膜 → `irides-l/r`。**左右按角色自己的左右重新命名**。
- upper_lip + lower_lip + mouth_interior → `mouth close`（闭嘴状态）；nose → `nose`；face → `face`；neck → `neck`；torso → `topwear`；四段手臂和两只手 → `handwear`（按左右分组，psd2live 的手臂规则如果需要别的结构，就按它的要求来）；background 层忽略。
- 映射规则写进 config（`segly_mapping`），不能写死在代码里。

### C. 补画被遮挡区域（多源融合，本次的核心优化）
- **face**：把眼睛和嘴的区域挖掉，换成补画来源 face 层对应位置的皮肤；刘海下方的额头同样用补画来源补齐。
- **neck**：做成实心，向上延伸到下巴线以上 40–60px（参照 run4 的规则）。
- **back hair**：用补画来源的后发补齐被头挡住的部分。
- **眼睛**：沿用 step5 的规则。眼白取**原图中真实的眼皮开口形状**（必须是实心）；虹膜用补画来源的完整圆形，裁剪到眼皮开口内。
- **闭眼和口型**：使用 `assets/parts` 中的 `eye close-l/r`，以及 `mouth close`、`mouth small`、`mouth open` 三档互斥切换（参照 run4 的做法）。
- 原则：**能用 segly 的原图像素就用 segly（边缘最清晰），segly 缺失的部分才用补画来源**。每层都要报告「segly 像素占比 / 补画占比」。

### D. 合成 PSD → psd2live → 验收
- 合成 `native.psd`（1024×1536），拍平后和原图对比色差；角色内部空洞像素数必须为 0。
- 运行 psd2live（`--mesh-pixels --lang zh`）。验收导出沿用 run4 的全部姿态，包括：闭眼 L/R、视线 8 个方向、张嘴 0/0.2/0.5/0.8/1、转头 AngleX ±30、AngleY ±30、AngleZ ±20，再加 mp4 和 web。
- 指标沿用 run4：虹膜越界像素数、眼周暗线、脖子空洞、耳坠和嘴部重影连通块数、口型同屏可见层数。

### E. 三方对比
`run5/compare/`：对同一组姿态，把 run3、run4、run5 三版并排放在一起，眼部、嘴部、脖子各放大一张。

## 报告
写 `run5/report.md`：segly 已知特点的验证结论；清洗和映射的统计；多源融合的占比；所有指标与 run3、run4 的对比；可疑项；完整的复现命令。
