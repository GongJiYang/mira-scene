# Live2D 流水线：See-through PSD → 原分辨率重建 → psd2live

你是执行工程师。目标：把用户手工跑通的流程（`~/tools/pipeline-out/scripts/` 下的 3 个脚本是**上一次的参考实现**，参数写死在上一张图上）做成**通用、可复用的工具**，再用本次的输入跑一遍，每一步都输出检查图和数值，交给架构师验收。

## 铁律
1. 不得修改：`~/tools/psd2live/` 的源码、`~/Downloads/`、`~/Desktop/`、`~/tools/pipeline-out/scripts/`（只读参考）。
2. 每一步的数值和检查图必须**如实**记录。某一步没达标时，在报告里写明，**不要宣称"效果自然"**，由用户目测判断。
3. 说明与实际情况冲突时，停下来报告，不要擅自改动验收标准。
4. 不要 commit；不要留下常驻进程（http.server 跑完验证就关掉）。

## 输入
| 项 | 路径 |
|---|---|
| See-through PSD | `/Users/gjy/Downloads/seethrough_output (1).psd`（768×768，14 个图层：back hair, neck, topwear, handwear, earwear, ears, face, nose, mouth, eyewhite, eyebrow, irides, eyelash, front hair） |
| 原图 | `/Users/gjy/Desktop/立绘图/M1 · 主立绘（透明背景）.png`（1024×1536，RGBA，背景透明） |
| Python | `/Users/gjy/tools/see-through/.venv/bin/python`（已装 psd-tools、opencv、pillow、numpy），运行时加 `-I` |
| psd2live | `~/tools/psd2live`，`JAVA_HOME=/opt/homebrew/opt/openjdk@21` |

## 产出位置
- 工具代码：`/Users/gjy/mira-scene/tools/live2d-pipeline/`（`pipeline.py` 加若干模块，`run.sh` 一条命令跑完；所有参数从命令行或 `config.json` 读入，**不允许写死上一张图的数值**）。
- 本次运行产物：`/Users/gjy/tools/pipeline-out/run2/`，每一步一个子目录 `step3/`…`step8/`，每个子目录里放检查图和 `metrics.json`。

## 流程与每一步的优化要求

### 第 3 步：坐标映射（最容易出错）
- 公式：`side=max(w,h); padx=(side-w)/2; pady=(side-h)/2; s=768/side`；原图坐标 = PSD 坐标/s − pad。本次应得 s=0.5、padx=256、pady=0。
- **优化：自动校验**。把 PSD 的合成图映射回原图坐标后，与原图对比，在双方 alpha 都 >0.85 的区域计算平均绝对色差和边缘错位（px）。再在 ±3px、±1% 缩放范围内搜索，看能否进一步减小误差。如果搜索结果比公式结果好得多，就报告出来（说明 See-through 的预处理可能和公式不完全一致）。
- 检查图：原图与映射后合成图的 50% 叠加图、差值热力图。

### 第 4 步：部件放大到原分辨率
- 规则（来自上次的实际运行）：alpha 用双三次插值放大；像素 α>0.85 且放大后的颜色与原图平均绝对差 <34 时，取原图像素，否则保留模型颜色（这是被遮挡后补画的区域）。
- **优化：阈值不要写死**。为每个图层输出「取原图像素占比」「补画占比」，并给出阈值分别取 24/34/44 时的对比检查图。本次原图背景本来就是透明的，确认没有混入背景色。
- **新增：残差检查**。找出原图里 α>0.5、但所有图层的并集都没有覆盖到的像素（或者覆盖了，但颜色差异很大的区域）。本次预计**脖子上的耳机丢失了**（See-through 把它当成遮挡物去掉了，topwear 上残留了阴影）。把残差连通块面积和位置报告出来。面积大于 2000px 的连通块，用原图像素生成一个独立图层：耳机命名为 `neckwear`，其他命名为 `objects`，放在 topwear 之上、face 之下。同时用原图像素修复 topwear 上的阴影污染：被 neckwear 覆盖的区域，topwear 维持补画色即可，不需要处理。
- 检查图：每个图层单独的缩略图拼成一张，残差掩码图。

### 第 5 步：重建眼睛（See-through 输出质量最差的地方）
上次确认过的规则：
- eyewhite 必须是**实心**椭圆（psd2live 会把 irides 裁剪到 eyewhite 范围内，环形眼白会把虹膜裁掉）。
- irides 补全：在可见的虹膜像素上用最小二乘拟合圆；被上眼皮遮住的上缘，以水平线为轴镜像补全。
- eyewhite：以虹膜圆心为中心，按睫毛主方向旋转（上次是 ±10°–17°），生成 rx≈1.34r、ry≈1.02r 的椭圆；颜色取眼白区域最亮的 15% 像素的中位数，再向中性灰拉近。
- eyelash：用原图的暗笔画（亮度 <110）作为 alpha，保留抗锯齿，去掉面积 <24px 的碎点。
- 左右命名按角色自身：`-l` = 角色的左眼 = **图像右侧**。
- **优化 1：虹膜颜色不要写死**。上次的角色是紫色瞳孔（H 128–170），这次是**灰蓝色**。从 irides 图层的像素自动估计主色，取 HSV 主峰 ±容差；拟合时输出半径和残差。
- **优化 2：左右拆分**。眼白、虹膜、睫毛按图像中线自动拆成 -l、-r 两份；眉毛和嘴不拆。
- **优化 3：参数报告**。输出每只眼的圆心、半径、睫毛主方向角、椭圆参数，与上次的经验值（r≈18–20px@原图1534 宽；本次原图宽 1024，**按比例**预期 r 约为 12–14px）做对比。
- 检查图：眼部区域放大 4 倍，分别展示原图 / 重建后的叠加 / 只有眼白+虹膜 / 只有睫毛。

### 第 6 步：合成 PSD
- 画布用原图尺寸 1024×1536；图层名保持 See-through 的原名（拆分后的加 `-l`/`-r`），新增的 `neckwear`/`objects` 按第 4 步的规则放置。
- 自下而上：其余图层照抄原 PSD 的顺序，眼部依次为 eyewhite-l/r → irides-l/r → eyelash-l/r → eyebrow，**front hair 必须在最上层**。
- 写 PSD：沿用参考实现的写法（参考 `build_final_psd.py`）。
- **自检**：把合成后的 PSD 拍平，与原图对比平均色差，应 ≤ 第 3 步的结果；输出拍平图。

### 第 7 步：运行 psd2live
```bash
cd ~/tools/psd2live
JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew run -q --args="--input <native.psd> --output /Users/gjy/tools/pipeline-out/run2/step7/out --mesh-pixels --lang zh"
```
`--mesh-pixels` 不要漏掉。检查产物齐全：moc3、cmo3、model3.json、physics3.json、4 个 motion3。日志里出现任何警告或丢失报告，都要原文记录。

### 第 8 步：验收导出（不要只看静态图）
```bash
./gradlew run -q --args="export <native.psd> --target psd-pose --set pose=ParamEyeLOpen=0 --output .../step8/p1"
./gradlew run -q --args="export <native.psd> --target psd-pose --set pose=ParamEyeBallX=1,ParamEyeBallY=0.8 --output .../step8/p2"
./gradlew run -q --args="export <native.psd> --target mp4 --set clip=Idle --set size=768 --output .../step8/v"
./gradlew run -q --args="export <native.psd> --target web --output .../step8/web"
```
- 额外导出：`ParamEyeROpen=0`（另一只眼）、`ParamMouthOpenY=1`（张嘴）、`ParamAngleX=30`、`ParamAngleX=-30`（左右转头）。
- 自动判据（能算的都算出来）：闭眼一侧，睫毛区域在竖直方向压缩成一条线（计算闭眼前后睫毛 alpha 的竖向范围之比）；看向右上时，虹膜完全落在眼白椭圆内（越界像素数 = 0）；在 Idle 视频中抽帧，能找到眨眼帧（用睫毛区域的竖向范围变化判断）。
- 检查图：所有姿态拼成一张对比图；从 mp4 中每 0.5s 抽一帧拼成网格。

## 已知的工具限制（只记录，不处理）
双手在同一层（handwear），不会自动拆成左右；本次构图是半身，没有坐姿和腿部问题。

## 报告
写 `/Users/gjy/tools/pipeline-out/run2/report.md`：每一步的数值、相对参考实现做了哪些优化、哪些没达标、每张检查图的路径、你自己判断的可疑项。最后列出完整的复现命令（`run.sh`）。
