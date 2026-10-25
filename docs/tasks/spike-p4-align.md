# 探针 P4：差分图配准与局部贴片（实验，不是正式功能）

你是执行工程师。这是一个**实验性探针**（Cynefin 复杂域）：目标是用最少的代码回答一个问题，**不用追求工程完备**。
不要改动 `docs/architecture/`、`packages/`、`apps/`，不要 commit。所有产出放在 `tools/spike-align/` 和 `assets/parts/`。
背景（只读）：`docs/architecture/decisions.md` 的 D24、D26。

## 铁律
1. 说明与验收冲突时，停下来写进报告，不要改验收标准。
2. **不得修改 `assets/raw/` 中的任何文件**（这些是原画，只读）。
3. 如果某个差分的配准失败，如实报告，不要用手调参数让某一张"看起来过了"却不说明。

## 要回答的问题
用户用对话式生图工具做出的表情、手势差分图，尺寸、缩放、位置都和主立绘不一致。**能否用代码自动把它们对齐到主立绘，再只取局部贴回去，让来回切换时五官不跳？**

## 输入（`assets/raw/`）
| 文件 | 尺寸 | 说明 |
|---|---|---|
| `master.png` | 1024×1536 RGBA | 主立绘 M1，**唯一的坐标基准** |
| `x_eyelid_half.png` | 1024×1536 | 已经和 master 基本对齐，也要走一遍配准来验证 |
| `x_eyelid_closed.png` `x_brow_sad.png` `x_brow_raised.png` `x_mouth_small.png` `x_mouth_open.png` `x_mouth_o.png` `x_mouth_smile.png` `x_mouth_sad.png` `x_blush.png` | 1254×1254 RGBA | 表情差分：整张图重新生成过，缩放和位置都不同（`x_mouth_o` 的脸明显更大） |
| `a1_arm_cup.png` `a2_arm_polaroid.png` `a3_arm_camera.png` `a4_arm_phone.png` | 1254×1254 RGBA | 手势差分，同样是整张重新生成的 |
| `b4_fg_table_v_checker.png` | 1254×1254 RGB，**没有透明通道** | 桌面前景，上方的「透明」其实是画进图里的灰白棋盘格 |

## 区域参考（master 坐标，近似值，可以在此基础上自动扩展）
- 眉毛：x 330–690, y 330–395
- 眼睛：x 330–690, y 360–455
- 嘴：x 430–590, y 470–570
- 脸颊（blush）：x 330–690, y 420–530
- 手势：y ≥ 760 的整个下半身区域

## 方法
1. 用 Python 3（`tools/spike-align/.venv`，依赖只允许 `opencv-python-headless`、`numpy`），提供脚本 `tools/spike-align/align.py`。
2. **配准**：对每张差分图，用 AKAZE 或 SIFT 特征加 RANSAC，求一个**相似变换**（`cv2.estimateAffinePartial2D`：平移、旋转、等比缩放），把差分图映射到 master 的 1024×1536 坐标系。
   - 特征只能从**不会变化的区域**提取（头发轮廓、耳机、风衣领子），**要排除**正在变化的区域：表情差分排除脸部区域，手势差分排除 y ≥ 760 的区域。
3. **贴片**：变换后，在对应区域内计算和 master 的差异，生成掩码（阈值 + 膨胀 + 高斯羽化，羽化半径约 6–12px）。输出一张**和 master 同尺寸的 RGBA**，只保留掩码内的像素，其余全透明，保存为 `assets/parts/<名字去掉前缀>.png`，例如 `assets/parts/mouth_open.png`。
4. **桌面抠图**：把 `b4_fg_table_v_checker.png` 里的棋盘格背景去掉（棋盘格是低饱和的灰白两色交替，桌面和物件颜色饱和、偏暖；桌沿基本是一条水平线），输出 `assets/parts/fg_table_v.png`（RGBA）。热气被抠掉没关系。
5. **数值报告**：每张差分输出内点数、重投影误差（px）、缩放比例、旋转角度，以及「稳定区域」在配准后与 master 的平均绝对差。

## 预览页（给用户目测验收用，最重要的产出）
`tools/spike-align/preview.html`：纯静态页面，用 `python3 -m http.server` 就能打开，不依赖任何第三方库。
- 底层显示 master，上面叠加所选贴片。
- 每张贴片一个按钮，可以开关；另有一个「闪烁对比」开关，以 2Hz 频率在 master 和 master+贴片之间切换。
- 一个「眨眼演示」：每 3 秒执行一次 open → half → closed → half → open（每帧 60ms）。
- 一个「口型演示」：按 closed → small → open → small 循环。
- 页面右上角显示这张差分的配准数值。
- 竖屏手机宽度下可以正常查看。

## 完成标准
- `tools/spike-align/run.sh` 一条命令完成：创建 venv、安装依赖、跑完全部处理、打印预览页的启动方式。
- `assets/parts/` 下有 10 张表情贴片、4 张手势贴片、1 张桌面，全部是 1024×1536 RGBA（桌面除外：保持宽高比，宽 1024）。
- 写一份 `docs/tasks/spike-p4-report.md`：每张图的数值表；**你自己判断的可疑项**（误差大、内点少、掩码明显不对）；你遇到的问题；最后**不要宣称「效果自然」**，这一点由用户目测判断。
