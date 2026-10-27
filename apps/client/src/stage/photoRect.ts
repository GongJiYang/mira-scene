/**
 * S4 遗留 ②（S5 §4）：照片放大时的位置与尺寸。
 *
 * 纯函数（架构关卡 §3），无 DOM、无时钟。外壳（Stage.tsx）用 ResizeObserver 量出**舞台框**
 * 尺寸后调这里，得到放大态照片的像素矩形。
 *
 * 契约（架构关卡 §4 · 后置条件）：
 * 1. 结果完整落在舞台内；
 * 2. 结果与 `faceBox` 换算出的人物脸部像素区域**不相交**（照片放大后不挡脸）。
 *
 * `faceBox` 以舞台百分比表示，按当前占位角色（`master_clean.png`，1024×1536）的脸部位置标定：
 * 脸从发际线到下巴大约在 x 0.38–0.63、y 0.16–0.39，这里外扩一圈，把头顶头发也算进去。
 */

export type Size = { width: number; height: number };
export type Rect = { left: number; top: number; width: number; height: number };
/** 以舞台百分比（0–1）表示的矩形。 */
export type PercentBox = { left: number; top: number; width: number; height: number };

/** 拍立得照片的高宽比（与 stage.css 的 1/1.18 一致）。 */
export const PHOTO_ASPECT = 1.18;
/** 放大态照片相对舞台宽度的上限。 */
export const PHOTO_MAX_WIDTH_RATIO = 0.62;
/** 与舞台上下边缘/脸部之间留的空隙（占舞台高度的比例）。 */
export const PHOTO_MARGIN_RATIO = 0.03;

/**
 * 占位角色的脸部框（舞台百分比）。
 * 标定依据：`assets/parts/master_clean.png`（1024×1536，2:3，`object-fit: cover` 铺满舞台）。
 * 发际线到下巴约 y 0.16–0.39，头顶头发从 y≈0.05 起，故取 y 0.05–0.42、x 0.33–0.67。
 */
export const FACE_BOX: PercentBox = { left: 0.33, top: 0.05, width: 0.34, height: 0.37 };

/** 百分比框 → 舞台像素矩形。 */
export function faceBoxRect(stage: Size, faceBox: PercentBox = FACE_BOX): Rect {
  return {
    left: faceBox.left * stage.width,
    top: faceBox.top * stage.height,
    width: faceBox.width * stage.width,
    height: faceBox.height * stage.height,
  };
}

/** 两个矩形是否有**正面积**重叠（相切/贴边不算相交）。 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * 放大态照片的矩形：水平居中，纵向放在「脸的上方或下方」中更宽裕的一侧，
 * 尺寸取「不超过舞台宽度的 62%」与「该侧可用高度」中更小的一个。
 */
export function photoRect(stage: Size, faceBox: PercentBox = FACE_BOX): Rect {
  const width = Math.max(0, stage.width);
  const height = Math.max(0, stage.height);
  const gap = PHOTO_MARGIN_RATIO * height;

  const face = faceBoxRect({ width, height }, faceBox);
  const faceTop = face.top;
  const faceBottom = face.top + face.height;

  // 脸的下方 / 上方各能放多高（各留两段空隙）。
  const belowHeight = height - faceBottom - 2 * gap;
  const aboveHeight = faceTop - 2 * gap;
  const available = Math.max(belowHeight, aboveHeight);

  const maxWidth = PHOTO_MAX_WIDTH_RATIO * width;
  const photoWidth = Math.max(0, Math.min(maxWidth, available / PHOTO_ASPECT));
  const photoHeight = photoWidth * PHOTO_ASPECT;
  const left = (width - photoWidth) / 2;
  const top = belowHeight >= aboveHeight ? height - photoHeight - gap : gap;

  return { left, top, width: photoWidth, height: photoHeight };
}
