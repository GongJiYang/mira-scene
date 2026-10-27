import { describe, expect, it } from "vitest";
import {
  initialNudgeLimitState,
  NUDGE_MAX_CONSECUTIVE,
  NUDGE_MIN_INTERVAL_MS,
  nudgeLimit,
  type NudgeLimitState,
} from "../src/state/nudge";

function send(state: NudgeLimitState, at: number): NudgeLimitState {
  const decision = nudgeLimit(state, { type: "NUDGE", at });
  expect(decision.send).toBe(true);
  return decision.state;
}

describe("nudge 频率限制（§7）", () => {
  it("首次立即发送，30s 内第二次被间隔限制拦下", () => {
    const first = nudgeLimit(initialNudgeLimitState, { type: "NUDGE", at: 0 });
    expect(first.send).toBe(true);
    expect(first.state).toEqual({ lastSentAt: 0, consecutive: 1 });

    const tooSoon = nudgeLimit(first.state, { type: "NUDGE", at: NUDGE_MIN_INTERVAL_MS - 1 });
    expect(tooSoon.send).toBe(false);
    expect(tooSoon.reason).toBe("interval");
    expect(tooSoon.state).toBe(first.state);
  });

  it("间隔满 30s 后可再发", () => {
    const first = send(initialNudgeLimitState, 0);
    const later = nudgeLimit(first, { type: "NUDGE", at: NUDGE_MIN_INTERVAL_MS });
    expect(later.send).toBe(true);
    expect(later.state.consecutive).toBe(2);
  });

  it("用户没说话时最多连续 3 次，第 4 次被拦", () => {
    let state = initialNudgeLimitState;
    for (let index = 0; index < NUDGE_MAX_CONSECUTIVE; index += 1) {
      state = send(state, index * NUDGE_MIN_INTERVAL_MS);
    }
    expect(state.consecutive).toBe(NUDGE_MAX_CONSECUTIVE);

    // 间隔早就满足，仍应被「连续 3 次」拦下。
    const blocked = nudgeLimit(state, { type: "NUDGE", at: 10 * NUDGE_MIN_INTERVAL_MS });
    expect(blocked.send).toBe(false);
    expect(blocked.reason).toBe("consecutive");
  });

  it("用户一开口就重置连续计数，之后可以再触发 3 次", () => {
    let state = initialNudgeLimitState;
    for (let index = 0; index < NUDGE_MAX_CONSECUTIVE; index += 1) {
      state = send(state, index * NUDGE_MIN_INTERVAL_MS);
    }
    const at = 10 * NUDGE_MIN_INTERVAL_MS;
    const spoke = nudgeLimit(state, { type: "USER_SPEAK" });
    expect(spoke.state.consecutive).toBe(0);

    const afterSpeak = nudgeLimit(spoke.state, { type: "NUDGE", at });
    expect(afterSpeak.send).toBe(true);
    expect(afterSpeak.state.consecutive).toBe(1);
  });

  it("用户开口不解除 30s 间隔限制", () => {
    const state = send(initialNudgeLimitState, 1_000);
    const spoke = nudgeLimit(state, { type: "USER_SPEAK" }).state;
    expect(nudgeLimit(spoke, { type: "NUDGE", at: 1_000 + NUDGE_MIN_INTERVAL_MS - 1 }).send).toBe(false);
    expect(nudgeLimit(spoke, { type: "NUDGE", at: 1_000 + NUDGE_MIN_INTERVAL_MS }).send).toBe(true);
  });
});
