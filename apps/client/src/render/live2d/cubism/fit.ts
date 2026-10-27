/**
 * 忧奈预览页构图（S6a-fix2）。
 *
 * 目标：人物**完整显示**（耳朵到腿不被裁）、尽量大（高度约占画布 92%）、水平居中；
 * 画布填满预览页左侧区域并随窗口自适应。
 *
 * 纯函数 `fitModel` 把「画布尺寸 + 模型可见包围盒 + 构图预设」算成模型矩阵参数
 * `{ scale, x, y }`。渲染外壳只负责把结果写进 `CubismModelMatrix`，不含任何构图决策。
 */

/** 模型可见区域包围盒，单位为模型坐标（原点 = 模型画布中心，同 `getDrawableVertexPositions`）。 */
export type ModelBounds = {
  /** 可见区域左边界（模型坐标 X）。 */
  left: number;
  /** 可见区域右边界（模型坐标 X）。 */
  right: number;
  /** 可见区域下边界（模型坐标 Y）。 */
  bottom: number;
  /** 可见区域上边界（模型坐标 Y）。 */
  top: number;
};

/** 一组构图常量：可见区域高度占画布的比例，以及水平 / 垂直微调。 */
export type FitPreset = {
  /** 人物高度（可见区域高）占画布高度的比例，例如 0.92。 */
  heightRatio: number;
  /** 可见区域中心相对画布中心的水平偏移（画布宽度比例，+ 向右）。 */
  offsetXRatio: number;
  /** 可见区域中心相对画布中心的垂直偏移（画布高度比例，+ 向上）。 */
  offsetYRatio: number;
};

/**
 * 模型可见区域包围盒（`MODEL_BOUNDS`）。
 *
 * 坐标系：模型坐标（原点 = 模型画布中心，`getDrawableVertexPositions` 的原始单位）。
 * `draw()` 直接把模型矩阵 `scale(s) + translate(x,y)` 作用在这些坐标上，所以本常量
 * **不做任何单位换算**，就是实测到的模型坐标。
 *
 * 测量方法（离线实测一次，见 `s6a-report.md` 的「fix2」一节）：
 * 1. 加载 `/?preview=yuna`，等模型就绪；
 * 2. 逐 drawable 读 `model.getDrawableVertexPositions(i)`（模型坐标，原点 = 画布中心），
 *    跳过 `getDrawableOpacity(i) < 0.01` 的不可见 drawable；
 * 3. 对可见顶点取 min/max —— 即本表。
 *
 * 用「可见区域」而非整张画布：模型画布（`getCanvasWidth×Height` = 1.0 × 1.385）里
 * 角色两侧留白很多，直接按整张画布构图会让人物很小。
 * 读数会随呼吸 / 物理有 ≤1% 抖动，这里取静息帧。
 */
export const MODEL_BOUNDS: ModelBounds = {
  left: -0.3391,
  right: 0.3786,
  bottom: -0.6794,
  top: 0.6804,
};

/**
 * 构图预设（S6a-fix2 §3：缩放、X/Y 偏移分 `desktop` / `mobile` 两组，集中此处）。
 *
 * - `desktop`：宽画布，人物高约占 92%，水平居中。
 * - `mobile`：窄且高，人物高同样约 92%（宽度放不下时会自动按宽度收紧），水平居中。
 */
export const FIT_PRESETS: Record<"desktop" | "mobile", FitPreset> = {
  desktop: { heightRatio: 0.92, offsetXRatio: 0, offsetYRatio: 0 },
  mobile: { heightRatio: 0.92, offsetXRatio: 0, offsetYRatio: 0 },
};

/**
 * S6b §3：直播间构图（用户 2026-10-27 确认）。
 *
 * 忧奈模型是固定半蹲姿势（没有腿部/姿势参数），直播间做**全身展示**，
 * 让背景适应角色：低机位卧室地面 + 空的大软垫，她蹲在软垫前。
 *
 * - `liveDesktop`：人物高约画面 80%，中心在 56% 高处（0.56 - 0.5 = +0.06 向上）。
 * - `liveMobile`：人物高约 62%，中心在 66% 高处（0.66 - 0.5 = +0.16 向上）。
 *
 * 垂直偏移用 `offsetYRatio`（+ 向上）表达「中心在画面 N% 高处」。
 */
export const LIVE_FIT_PRESETS: Record<"liveDesktop" | "liveMobile", FitPreset> = {
  liveDesktop: { heightRatio: 0.8, offsetXRatio: 0, offsetYRatio: 0.56 - 0.5 },
  liveMobile: { heightRatio: 0.62, offsetXRatio: 0, offsetYRatio: 0.66 - 0.5 },
};

/** 直播间画布宽度 → 预设名（与 §4 的 900px 断点一致）。 */
export const LIVE_MOBILE_MAX_WIDTH = 900;

export function livePresetFor(canvasW: number): "liveDesktop" | "liveMobile" {
  return canvasW < LIVE_MOBILE_MAX_WIDTH ? "liveMobile" : "liveDesktop";
}

/** 按画布宽度选择预设名（小于 `MOBILE_MAX_WIDTH` 视为移动端，与预览页 CSS 断点一致）。 */
export const MOBILE_MAX_WIDTH = 720;

/** 画布宽度 → 预设名。 */
export function presetFor(canvasW: number): "desktop" | "mobile" {
  return canvasW < MOBILE_MAX_WIDTH ? "mobile" : "desktop";
}

/**
 * `fitModel` 的输出，直接对应 `CubismModelMatrix` 的操作：
 * `scale(scale, scale)` 之后 `translate(x, y)`。
 *
 * 即模型点 `p`（画布中心为原点、画布高 = 2.0 的空间）被映射到 `(p.x*s + x, p.y*s + y)`。
 */
export type FitResult = {
  /** 等比缩放。 */
  scale: number;
  /** 平移 X（缩放后模型原点在画布归一化空间的位置）。 */
  x: number;
  /** 平移 Y。 */
  y: number;
};

/**
 * 把模型可见包围盒放进画布并居中放大（S6a-fix2 §3，纯函数）。
 *
 * @param canvasW 画布宽度（CSS 像素）。
 * @param canvasH 画布高度（CSS 像素）。
 * @param bounds  模型可见区域包围盒（模型坐标）。
 * @param preset  构图预设。
 * @returns `{ scale, x, y }`，供 `CubismModelMatrix.scale()` + `translate()` 使用。
 *
 * 归一化画布是「中心在原点、高恒为 2.0」的矩形，宽 = `2 * canvasW / canvasH`（保持像素宽高比）。
 * 高度优先：可见区域高 = `heightRatio * 2`；宽度放不下时按宽度收紧，保证左右不出画。
 */
export function fitModel(
  canvasW: number,
  canvasH: number,
  bounds: ModelBounds,
  preset: FitPreset,
): FitResult {
  const width = Math.max(canvasW, 1);
  const height = Math.max(canvasH, 1);

  // 可见区域尺寸与中心（画布高 = 2.0 的空间）。
  const boundsW = Math.max(bounds.right - bounds.left, 1e-6);
  const boundsH = Math.max(bounds.top - bounds.bottom, 1e-6);
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.bottom + bounds.top) / 2;

  // 归一化画布：高 2.0，宽随画布宽高比。
  const normCanvasH = 2.0;
  const normCanvasW = (width / height) * normCanvasH;

  // 高度优先，宽度兜底（取较小缩放：两个方向都装得下）。
  const scaleH = (preset.heightRatio * normCanvasH) / boundsH;
  const scaleW = normCanvasW / boundsW;
  const scale = Math.min(scaleH, scaleW);

  // 可见区域中心要落在的目标点（画布中心 + 预设偏移）。
  const targetX = preset.offsetXRatio * normCanvasW;
  const targetY = preset.offsetYRatio * normCanvasH;

  // 令 `(centerX*s + x, centerY*s + y) = (targetX, targetY)`。
  return {
    scale,
    x: targetX - centerX * scale,
    y: targetY - centerY * scale,
  };
}
