# Live2D 流水线 修复轮 1

背景：`docs/tasks/live2d-pipeline.md`（原任务）、`~/tools/pipeline-out/run2/report.md`、`tools/live2d-pipeline/findings.md`。铁律不变（不改 psd2live 源码、不动 Downloads/Desktop、不 commit、不留常驻进程；未达标就如实写出来）。
本轮产物输出到 `~/tools/pipeline-out/run3/`（run2 保留，不要覆盖，用来对比）。工具代码继续在 `tools/live2d-pipeline/` 上修改，所有新参数都写进 config。

架构师目测 run2 后发现以下 8 个问题。每个问题都要：修复 → 写一个**能自动算出来的指标** → 输出 run2/run3 并排对比的检查图。

## 1. 下巴和高领之间有透明缝（最严重）
- 现象：`step6/check_step6_composite.png` 里，下巴下方、高领上方有一条半透明带，能透出棋盘格背景。
- 指标：**空洞像素数**，即原图 α>0.5、拍平结果 α<0.5 的像素数。需要按区域分别报告，**角色内部的空洞必须为 0**。
- 修法提示：检查 neck 和 topwear 的 alpha 覆盖范围；要么让 neck 层向上延伸，伸到 face 下方，要么保证 topwear 领口上沿和 face 下沿之间没有缝。

## 2. 右侧头发上有一条肤色竖条
- 现象：拍平结果在图像右侧头发区域（约 x 600–690、y 150–350）出现一条米色/肤色竖条，差异热力图上是最亮的一块。
- 先定位它来自哪一层（逐层隐藏后重新拍平，看竖条是否消失），再修。原报告中的 `objects` 层（625,168)–(678,342) 很可能就是元凶，按 findings 的判断，它更像发丝，应并入 front hair，或者整层删掉。
- 指标：头发区域的平均色差，以及该区域的最大色差。

## 3. 闭眼：改用画好的闭眼图层
- 现象：闭眼时睫毛只往下平移，下方露出一条蓝色虹膜细边，眼白有残影。
- 修法：`/Users/gjy/mira-scene/assets/parts/eyelid_closed.png`（1024×1536，**已与 M1 逐像素对齐**，只有眼部非透明）。按图像中线拆成左右两半，作为 psd2live 的 `eye close` 变体图层（命名 `eye close-l` / `eye close-r`，标签 eye/closed，与对应的眼睛同组），让闭眼时切换到它。参照 psd2live 的 `docs/en/spec/PSD_LAYER_SPEC.md` 和 `DEFORMER_AND_PARAMETER_SPEC.md`，弄清楚 EYE_CLOSE 是怎么接到 ParamEyeLOpen/ROpen 上的。如果 PSD 名称机制做不到，就改用 psd2live 的 layout manifest（`docs/en/spec/LAYOUT_MANIFEST.md`）输入。
- 指标：闭眼姿态下，眼白区域内虹膜色相像素数 = 0；闭眼区域和 eyelid_closed 原图的平均色差。

## 4. 张嘴：加入画好的口型
- `assets/parts/mouth_open.png`、`assets/parts/mouth_small.png`（同样已与 M1 对齐）作为 `mouth open` 变体（标签 mouth/open）；原来的 mouth 作为 `mouth close`。
- 指标：`ParamMouthOpenY=1` 与 0 两个姿态在嘴部区域的差异像素数，必须明显大于 run2。另外导出 `ParamMouthOpenY=0.5` 的姿态检查图。

## 5. 虹膜外圈的浅色光环
- 现象：所有姿态里，虹膜外缘都有一圈细的浅色亮边。
- 修法：虹膜 alpha 向内收 1–2px 再羽化；边缘像素的 RGB 用虹膜内侧的颜色做去色边（去 matte）。
- 指标：虹膜外缘 2px 环带的平均亮度，与内侧 3px 环带的亮度之差。

## 6. 睫毛上方有褐色碎笔触
- 现象：睫毛层里混进了发丝等暗笔画碎片，漂在眼睛上方。
- 修法：只保留与睫毛主曲线相连、并且落在眼白椭圆上方一定距离以内的连通块；其余删掉。
- 指标：睫毛层的连通块数量，以及每块的面积，run2 和 run3 对比。

## 7. 前发边缘有锯齿
- 现象：front hair 的边缘呈阶梯状（alpha 从 768 放大 2 倍造成）。
- 修法：凡是图层边界与原图轮廓重合的地方，alpha 直接取原图 alpha（足够清晰）；其余地方用更平滑的放大方式（Lanczos 加轻微高斯），不要用最近邻插值。
- 指标：沿 front hair 边缘统计 alpha 梯度的「阶梯度」（相邻像素 alpha 变化的直方图），run2 和 run3 对比。

## 8. 眼白比例
- 眼白高度系数 `sclera_ry_ratio` 改为 1.15（findings 的建议）。但看向右上时，眼白不能露出眼眶：把眼白裁剪到「上睫毛下沿和下眼睑线之间」的开口区域内，开口区域取自原图。
- 指标：看向右上时，虹膜被裁掉的像素比例；眼白超出眼眶开口的像素数（要求 = 0）。

## 完成标准
- `run.sh` 一条命令重新生成 run3，第 3–8 步全部产出，验收导出包括原来的 7 个姿态、`ParamMouthOpenY=0.5`、mp4 和 web。
- 新增 `run3/compare/`：每个问题一张 run2 和 run3 的并排对比图。
- 在 `run3/report.md` 里，用一张表列出 8 个问题各自的指标（run2 → run3）以及是否达标，加上新的可疑项。依旧**不要宣称效果自然**。
