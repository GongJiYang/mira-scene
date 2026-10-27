/**
 * S6b-fix2 §2：手机竖屏角色基底层的底部裁切量（纯函数，无 DOM、无时钟）。
 *
 * 问题：夏凛分层立绘里，前景桌（fg:table）只在「桌沿完全不透明下沿」以下才完全不透明；
 * 桌沿以上是透明/半透明斜面。角色基底（char:base 等，2:3 contain）下沿伸到桌沿下沿之下时，
 * 下半身（手、风衣下摆）会从桌沿的完全不透明区域以下透出，看起来像桌子悬在她身上。
 *
 * 改法：手机竖屏把角色各图层按「前景桌的完全不透明下沿」裁切——桌沿下沿以下只显示背景。
 * 裁切量由本函数按两个图层矩形计算；外壳把结果写进 `clip-path: inset(0 0 Npx 0)`。
 *
 * 本函数直接接收两个图片在**舞台坐标系**里的渲染矩形（top/height），
 * 以及前景桌的完全不透明下沿在其图片内的归一化位置（0–1，从图顶算起）。
 * 返回角色图片矩形底部需要裁掉的像素数（≥0）。
 */

export type RenderedImage = {
  /** 图片在舞台坐标系里的渲染矩形顶边 y（px）。 */
  top: number;
  /** 图片在舞台坐标系里的渲染高度（px）。 */
  height: number;
};

/** 前景桌完全不透明下沿：桌面图片里「从图顶算起，首次整行不透明的行」的归一化 y（0–1）。 */
export const FG_TABLE_OPAQUE_EDGE = 0.8;

/**
 * 角色图片底部需要裁掉的像素数。
 *
 * 桌沿完全不透明下沿的舞台 y = table.top + table.height × FG_TABLE_OPAQUE_EDGE。
 * 角色图片底边 y = char.top + char.height。
 * 若角色底边伸到桌沿下沿之下，超出部分即应裁掉（桌沿以下只显示背景）。
 * 否则（角色底边在桌沿下沿之上）不裁。
 */
export function charClipBottom(char: RenderedImage, table: RenderedImage): number {
  const tableEdge = table.top + table.height * FG_TABLE_OPAQUE_EDGE;
  const charBottom = char.top + char.height;
  const overflow = charBottom - tableEdge;
  return overflow > 0 ? Math.round(overflow) : 0;
}

/**
 * contain 布局：给定容器（宽/高）与图片纵横比（宽/高），求图片在容器内的渲染矩形。
 * 图片水平居中、垂直居中（object-fit: contain 的默认 object-position: 50% 50%）。
 * 返回相对容器顶边的 top/height（宽度从略——本函数只裁纵向）。
 */
export function containRect(
  container: { width: number; height: number },
  imageAspect: number,
): RenderedImage {
  const cw = Math.max(0, container.width);
  const ch = Math.max(0, container.height);
  if (imageAspect <= 0 || cw === 0 || ch === 0) return { top: 0, height: 0 };
  // contain：图片宽 = min(容器宽, 容器高 × 纵横比)；高 = 宽 / 纵横比。
  let width = cw;
  let height = width / imageAspect;
  if (height > ch) {
    height = ch;
    width = height * imageAspect;
  }
  const top = (ch - height) / 2;
  return { top, height };
}
