/**
 * 布局与手势（S6b §4）：纯函数。
 *
 * - `pickLayout(width)`：宽 ≥ 900px 用桌面（仿 Twitch），否则手机（仿 TikTok / Instagram 直播）。
 * - `swipeDecision(dy, vy)`：上下滑动切主播的判定（阈值约 80px 或速度足够）。
 */

export type LiveLayout = "desktop" | "mobile";

/** 桌面 / 手机的断点（S6b §4）。 */
export const DESKTOP_MIN_WIDTH = 900;

export function pickLayout(width: number): LiveLayout {
  return width >= DESKTOP_MIN_WIDTH ? "desktop" : "mobile";
}

/** 滑动切换的位移阈值（px）。 */
export const SWIPE_DISTANCE_PX = 80;
/** 速度阈值（px/ms）：快速轻扫也能切换。 */
export const SWIPE_VELOCITY = 0.5;

export type SwipeDirection = "next" | "prev" | null;

/**
 * 上下滑动 → 切换方向。
 *
 * 约定：向上滑（dy < 0）= 看下一个主播；向下滑（dy > 0）= 上一个。
 * 位移超过阈值，或速度足够快（且方向一致）时触发。
 */
export function swipeDecision(dy: number, vy: number): SwipeDirection {
  if (!Number.isFinite(dy) || !Number.isFinite(vy)) return null;
  const farEnough = Math.abs(dy) >= SWIPE_DISTANCE_PX;
  const fastEnough = Math.abs(vy) >= SWIPE_VELOCITY;
  // 速度与位移方向必须一致，避免「先滑下去又快速弹回」误触发。
  const sameDirection = dy === 0 ? false : Math.sign(dy) === Math.sign(vy) || vy === 0;
  if (!farEnough && !(fastEnough && sameDirection)) return null;
  return dy < 0 ? "next" : "prev";
}

/** 频道列表按顺序循环切换（上下滑到头时回到另一端）。 */
export function cycleChannel<T>(list: readonly T[], current: T, direction: "next" | "prev"): T {
  if (list.length === 0) return current;
  const index = list.indexOf(current);
  if (index < 0) return list[0] as T;
  const delta = direction === "next" ? 1 : -1;
  const next = (index + delta + list.length) % list.length;
  return list[next] as T;
}
