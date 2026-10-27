/**
 * 主动开口的频率限制（D32，架构关卡：纯函数，写单测）。
 *
 * 规则（§7）：
 * - 每 30s 最多 1 次；
 * - 用户没说话时最多连续触发 3 次；
 * - 用户一开口就重置计数。
 *
 * 「条件是否满足」（A 为 idle、连接正常）由外壳判断，这里只管频率。
 */

export const NUDGE_MIN_INTERVAL_MS = 30_000;
export const NUDGE_MAX_CONSECUTIVE = 3;

export type NudgeLimitState = {
  /** 上一次成功发送 nudge 的时刻；从未发送为 null。 */
  lastSentAt: number | null;
  /** 用户上一次开口之后，已经连续主动开口的次数。 */
  consecutive: number;
};

export const initialNudgeLimitState: NudgeLimitState = { lastSentAt: null, consecutive: 0 };

export type NudgeLimitEvent =
  | { type: "NUDGE"; at: number }
  | { type: "USER_SPEAK" };

export type NudgeLimitReason = "interval" | "consecutive";

export type NudgeLimitDecision = {
  state: NudgeLimitState;
  send: boolean;
  reason: NudgeLimitReason | null;
};

export function nudgeLimit(state: NudgeLimitState, event: NudgeLimitEvent): NudgeLimitDecision {
  if (event.type === "USER_SPEAK") {
    // 用户开口：连续计数归零（间隔限制仍然有效，避免说话后立刻抢话）。
    return { state: { ...state, consecutive: 0 }, send: false, reason: null };
  }

  if (state.lastSentAt !== null && event.at - state.lastSentAt < NUDGE_MIN_INTERVAL_MS) {
    return { state, send: false, reason: "interval" };
  }
  if (state.consecutive >= NUDGE_MAX_CONSECUTIVE) {
    return { state, send: false, reason: "consecutive" };
  }

  return {
    state: { lastSentAt: event.at, consecutive: state.consecutive + 1 },
    send: true,
    reason: null,
  };
}
