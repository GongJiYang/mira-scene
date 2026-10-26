---
name: live2d-auto
description: >
  把一张动漫立绘自动做成可在网页驱动的 Live2D 模型：先用 See-through 或 segly.io 分层，再用本项目工具
  tools/live2d-pipeline 做原分辨率重建、补画遮挡、眼睛和口型的变体图层、自动指标，最后交给 psd2live
  自动绑定，导出 Cubism 全套文件、网页播放器和 mp4。适用场景：用户提到「立绘转 Live2D」「自动绑定」
  「See-through / segly 分层」「psd2live」「闭眼/口型/视线有问题」「Live2D 批量生成」，
  或者需要复跑、精修、验收 Live2D 模型。
---

# Live2D 自动化流水线

**核心观点**：Live2D 已经能在很大程度上由 AI 批量产出。现阶段的做法是「AI 生成 + 人工只修 AI 做不好的地方」。每修好一个瑕疵，就把它沉淀成一条能自动计算的指标和修复规则；最终目标是全自动的批量管线。
背景与迭代记录见 `docs/architecture/live2d-pipeline.md`，相关决策是 D33–D35。

## 0. 先决条件（只需配置一次）
| 项 | 做法 |
|---|---|
| psd2live | `git clone https://github.com/tsunehimatoi/psd2live ~/tools/psd2live` |
| JDK 21 | `brew install openjdk@21`，之后运行时一律加 `JAVA_HOME=/opt/homebrew/opt/openjdk@21` |
| Rust 运行时报错 `unable to run rust-objcopy` | `rustup component add llvm-tools-preview`，然后执行 `ln -sf ~/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/llvm-objcopy ~/.cargo/bin/rust-objcopy` |
| Python 环境 | 需要 psd-tools、opencv、pillow、numpy（本机：`~/tools/see-through/.venv`），路径写在 `config.json → env.python` |
| 示例下载 | psd2live 自带的 `tools/examples/fetch.py` 需要 Python ≥3.11（低版本没有 `hashlib.file_digest`） |

## 1. 准备输入（二选一）
| 分层来源 | 特点 | 流水线的处理 |
|---|---|---|
| **See-through**（开源，SIGGRAPH 2026） | 768×768 正方形；**会补画被遮挡的部分**；带语义标签 | 第 3 步把坐标映射回原图；第 4 步放大，原图像素和补画像素按阈值择优使用 |
| **segly.io** | 原分辨率；**纯分割、不补画**；有碎点；部分部件归类错误；`left` 指的是图像左侧 | 清洗碎点 → 重新做语义映射 → **多源融合**：被遮挡的区域借用 See-through 的补画层 |

另外必须准备：**原图 PNG**（和分层出自同一张图）。闭眼图、口型图（`assets/parts/`）可选，强烈建议提供。

## 2. 一条命令运行
```bash
cd ~/mira-scene/tools/live2d-pipeline
# 先修改 config.json：input（PSD / 原图）、output_dir，分层来源选 see-through 或 segly
./run.sh                       # 依次跑完 step3 到 step8、compare、report
./run.sh step5 step6           # 只重跑其中几步
./run.sh all --out ~/tools/pipeline-out/runN --set step4_upscale.color_tolerance=30   # 临时覆盖参数
```
每一步都会输出 `<out>/stepN/metrics.json` 和检查图，最后汇总成 `<out>/report.md`。

## 3. 流水线各步骤及每步必须守住的规则
| 步骤 | 做什么 | 必须守住（这些都是从历次踩坑中总结出来的） |
|---|---|---|
| 3 坐标映射 | 仅 See-through 需要：`side=max(w,h)`、`pad=(side-w)/2`、`s=768/side`，原图坐标 = PSD 坐标/s − pad | 自动校验映射误差；**不要沿用上一张图的 s 和 pad** |
| 4 原分辨率重建 | alpha 用双三次放大；α>0.85 并且和原图色差 <34 时，用原图像素 | 阈值按 24/34/44 三档出对比图；做**残差检查**，把原图有、但所有层都没有的部件（例如耳机）补成一层 |
| 5 眼睛 | 虹膜：用最小二乘拟合出完整的圆；眼白：取**真实眼皮开口形状**，实心；睫毛：只保留与主曲线相连的部分 | 眼白必须实心（psd2live 会把虹膜裁剪到眼白里）；**虹膜颜色要自动估计，不要写死**；左右按角色自身命名（`-l` = 图像右侧） |
| 5b 变体图层 | `eye close-l/r` 使用画好的闭眼图；`mouth close/small/open` **三档互斥** | 口型不能做交叉淡化，否则半张嘴时会出现两张嘴 |
| 6 合成 PSD | 画布用原图尺寸；`front hair` 放在最上层 | 拍平后与原图对比：**角色内部空洞 = 0**；脖子必须实心，并且延伸到下巴下方；face、hair 层里**不能残留耳坠、嘴这类重复部件** |
| 7 psd2live | `JAVA_HOME=… ./gradlew run -q --args="--input native.psd --output out --mesh-pixels --lang zh"` | **`--mesh-pixels` 不能漏**，否则长边超过 2048 的画布会被缩小；日志里的警告要原文记录 |
| 8 验收导出 | `export native.psd --target psd-pose --set pose=…`，以及 `--target mp4 --set clip=Idle`、`--target web` | 要覆盖以下姿态：闭眼 L/R、视线 8 个方向、张嘴 5 档、转头 AngleX/Y ±30、AngleZ ±20 |

## 4. 自动指标（质量门槛）
| 指标 | 达标线 |
|---|---|
| 角色内部空洞像素（原图 α>0.5，拍平后 α<0.5） | = 0 |
| 各视线姿态下，虹膜落在眼皮开口外的像素 | = 0 |
| 闭眼姿态下，眼白区域里的虹膜色相像素 | = 0 |
| 转头姿态下，下巴与领口之间的空洞 | = 0 |
| 耳坠、嘴的连通块数（转头时） | = 1 |
| 任一口型姿态中同时可见的口型层 | = 1 |
| Idle 视频中能检测到的眨眼帧 | ≥ 1 次 |
| 拍平图与原图的平均色差 | 记录趋势，只能变好，不能变差 |

**指标全部达标 ≠ 效果合格**：最终必须由人来目测，在网页播放器里拖动鼠标，测视线、转头、张嘴。历史上有过指标判为「达标」、人眼一看就不合格的情况（口型出现「水滴」），参见 run3 的记录。

## 5. 人机协作的边界
- **AI 负责**：拆层、坐标映射、重建、眼睛重建、变体图层、合成、绑定、导出、打分。
- **人负责**：分层工具都拆不出来的部件（脖子、下睫毛和卧蚕、眼睑褶线、耳机内胆、饰品接缝），手工抠出来放进 `overrides/<图层名>.png`，流水线会优先使用；另外，在 psd2live 的界面里调转头幅度、网格密度（`meshSpacing` 从 64 改为 32 能减少大角度时的折线感）。
- **升级方向**：人工每修一处，都要补一条能自动判定的指标；最终用 psd2live 的 MCP 接口（180+ 个操作）让 AI Agent 根据指标自动精修。

## 6. 常见问题速查
| 现象 | 原因 | 修法 |
|---|---|---|
| 往下看时整个眼球露出来，周围有一圈黑线 | 眼白椭圆比眼皮开口大；face 层残留了眼线 | 眼白改用真实的眼皮开口形状，并擦掉 face 层上的眼线 |
| 闭眼时露出一道蓝边 | 只有睫毛在平移，虹膜没被盖住 | 使用 `eye close` 变体图层 |
| 转头时出现两个耳坠或两张嘴 | 部件同时存在于自己的独立层和 face/hair 层 | 从 face/hair 层里抠掉，只保留独立层 |
| 脖子透明，或头和脖子分开 | 分层得到的 neck 层几乎是空的 | 重建一个实心的脖子，并向上延伸 |
| 前发边缘有锯齿 | alpha 被 2 倍放大 | 和原图轮廓重合的部分直接用原图 alpha；其余部分用 Lanczos 放大再轻微高斯模糊 |
| 左右眼动反了 | 左右命名弄反了 | psd2live 的 left 指角色自己的左边，也就是图像右侧 |


## 8. 参考资料与吸收的做法
- **隐藏区域参考包**（推荐）：原图上看不见的部位提前画好，不要事后补画。提示词见 `docs/live2d-ref-pack.md`（R1 无五官脸、R2 额头、R3 脖子、R4 眼睛部件、R5 耳机内胆、R6 耳坠交界），生成后放进 `overrides/`。
- [Kota-Ohno/seethrough-live2d-pipeline](https://github.com/Kota-Ohno/seethrough-live2d-pipeline)（MIT）：
  - `clean_face.py`：清掉 face 层上的细线和污点（闭眼时会露出来的区域），对应 run5 出现的「眼睑鬼影」；
  - 用 **ag-psd** 写出 PSD：用 Python 写的 PSD，Cubism Editor 可能显示为空白（作者实测）；需要进 Cubism 精修时必须换成 ag-psd；
  - Real-ESRGAN 4× 放大后再重投影到 4096px（可选，用来改善锯齿和细节）；
  - 失败排查表 `docs/pre-rig-failure-routing.md`。
- 平台规则：nizima 禁止上架或接单来源于 AI 生成插画的 Live2D 作品（2026-07）；本项目只做演示用途。

## 7. 产物
`<out>/step7/out/`：`*.moc3`、`*.cmo3`、`*.model3.json`、`*.physics3.json`，4 个动作文件（Idle/Blink/Nod/Shake）、4 个表情文件（angry/sad/smile/surprised）；`<out>/step8/web/`：网页播放器（需要通过 `python3 -m http.server` 托管）；`<out>/step8/v/`：mp4。可以直接导入 Cubism Editor 或 VTube Studio，也可以在网页里由状态机 B 驱动。
