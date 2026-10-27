/**
 * S6l-fix2 §6：poke / gift 的限流常量与纯函数（协议层共享）。
 *
 * 客户端有冷却（`interactionHooks.ts`），服务端此前没有——重复请求会起新轮并扣轮数。
 * 这里把冷却时长与判定函数放在协议层，客户端与服务端读同一份常量。
 */

/** 戳一下的服务端 / 客户端冷却（毫秒）。 */
export const POKE_COOLDOWN_MS = 3_000;
/** 送礼物的服务端 / 客户端冷却（毫秒）。 */
export const GIFT_COOLDOWN_MS = 10_000;

export type ThrottleKind = "poke" | "gift";

/** 冷却时长（按 kind 取）。 */
export function cooldownFor(kind: ThrottleKind): number {
  return kind === "gift" ? GIFT_COOLDOWN_MS : POKE_COOLDOWN_MS;
}

/**
 * 纯函数：给定同类事件上次被接受时刻 `lastAt`（无则为 null / undefined）与当前时刻 `now`，
 * 返回这次是否放行。
 *
 * - 从未触发过 → 放行；
 * - 距上次不足冷却时长（含时钟回退 `now < lastAt`）→ 忽略（返回 false）；
 * - 达到 / 超过冷却 → 放行。
 */
export function throttleEvent(lastAt: number | null | undefined, now: number, kind: ThrottleKind): boolean {
  if (lastAt === null || lastAt === undefined) return true;
  const elapsed = now - lastAt;
  if (elapsed < 0) return false;
  return elapsed >= cooldownFor(kind);
}
