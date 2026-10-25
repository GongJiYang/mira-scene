import { describe, expect, it } from "vitest";
import {
  MOUTH_MAX_MS,
  MOUTH_MIN_MS,
  NUDGE_AFTER_MS,
  PERFORMANCE_TICK_MS,
  createPerformanceClock,
  mouthDelayMs,
} from "../src/core/performanceClock";
import {
  IDLE_ACTIONS,
  initialPerformanceState,
  performanceReducer,
  type PerformanceAction,
  type PerformanceState,
  type StagePhaseKind,
} from "../src/state/performance";

function harness(options: { phase?: StagePhaseKind; idleSince?: number | null; rng?: () => number } = {}) {
  let now = 0;
  let phase = options.phase ?? "idle";
  let performance: PerformanceState = {
    ...initialPerformanceState,
    phase,
    phaseSince: 0,
    idleSince: options.idleSince === undefined ? 0 : options.idleSince,
  };
  const emitted: PerformanceAction[] = [];
  const nudges: number[] = [];
  const clock = createPerformanceClock({
    now: () => now,
    rng: options.rng ?? (() => 0),
    getPhase: () => phase,
    getPerformance: () => performance,
    emit: (action) => {
      emitted.push(action);
      performance = performanceReducer(performance, action);
    },
    onNudge: (at) => nudges.push(at),
  });

  return {
    clock,
    emitted,
    nudges,
    tickAt(at: number) {
      now = at;
      clock.tick();
    },
    transition(next: StagePhaseKind, at: number) {
      now = at;
      phase = next;
      performance = performanceReducer(performance, { type: "PHASE", phase: next, at });
    },
    performance: () => performance,
    actionsOfType<T extends PerformanceAction["type"]>(type: T) {
      return emitted.filter((action): action is Extract<PerformanceAction, { type: T }> => action.type === type);
    },
  };
}

describe("表演时钟：眨眼", () => {
  it("idle 进入后 2s（rng=0）开始眨眼，下一次按 2–6s 重排", () => {
    const h = harness({ idleSince: 1_000 });
    h.tickAt(1_000 + 2_000 - 1);
    expect(h.actionsOfType("BLINK")).toHaveLength(0);
    h.tickAt(1_000 + 2_000);
    expect(h.actionsOfType("BLINK")).toHaveLength(1);

    // 下一次眨眼在 2s 之后（rng 仍为 0）。
    h.tickAt(3_000 + 2_000 - 1);
    expect(h.actionsOfType("BLINK")).toHaveLength(1);
    h.tickAt(3_000 + 2_000);
    expect(h.actionsOfType("BLINK")).toHaveLength(2);
  });

  it("rng 接近 1 时第一次眨眼接近 6s", () => {
    const h = harness({ idleSince: 0, rng: () => 0.999_999 });
    h.tickAt(5_990);
    expect(h.actionsOfType("BLINK")).toHaveLength(0);
    h.tickAt(6_000);
    expect(h.actionsOfType("BLINK")).toHaveLength(1);
  });

  it("非 idle 时不眨眼", () => {
    const h = harness({ phase: "speaking", idleSince: null });
    for (let at = 0; at <= 10_000; at += PERFORMANCE_TICK_MS) h.tickAt(at);
    expect(h.actionsOfType("BLINK")).toHaveLength(0);
  });
});

describe("表演时钟：待机小动作", () => {
  it("idle 超过 8s 触发一次，动作来自 D28 候选集", () => {
    const h = harness({ idleSince: 0, rng: () => 0 });
    h.tickAt(8_000 - 1);
    expect(h.actionsOfType("IDLE_ACTION")).toHaveLength(0);
    h.tickAt(8_000);
    const actions = h.actionsOfType("IDLE_ACTION");
    expect(actions).toHaveLength(1);
    expect(IDLE_ACTIONS).toContain(actions[0]?.action);

    for (let at = 8_060; at <= 20_000; at += PERFORMANCE_TICK_MS) h.tickAt(at);
    expect(h.actionsOfType("IDLE_ACTION")).toHaveLength(1);
  });
});

describe("表演时钟：D32 主动行动", () => {
  it("idle 且 12s 无输入 → 一次 nudge", () => {
    const h = harness({ idleSince: 1_000 });
    h.tickAt(1_000 + NUDGE_AFTER_MS - 1);
    expect(h.nudges).toEqual([]);
    h.tickAt(1_000 + NUDGE_AFTER_MS);
    expect(h.nudges).toEqual([1_000 + NUDGE_AFTER_MS]);

    h.tickAt(1_000 + NUDGE_AFTER_MS + 5_000);
    expect(h.nudges).toHaveLength(1);
  });

  it("开始新一轮后重新计时", () => {
    const h = harness({ idleSince: 0 });
    h.tickAt(NUDGE_AFTER_MS);
    expect(h.nudges).toHaveLength(1);

    h.transition("thinking", 13_000);
    h.transition("speaking", 13_100);
    h.transition("idle", 20_000);
    h.tickAt(20_000 + NUDGE_AFTER_MS - 1);
    expect(h.nudges).toHaveLength(1);
    h.tickAt(20_000 + NUDGE_AFTER_MS);
    expect(h.nudges).toHaveLength(2);
  });

  it("非 idle 时不计时 nudge", () => {
    const h = harness({ phase: "thinking", idleSince: null });
    for (let at = 0; at <= 60_000; at += PERFORMANCE_TICK_MS) h.tickAt(at);
    expect(h.nudges).toEqual([]);
  });
});

describe("表演时钟：说话口型间隔", () => {
  it("random=0 → 90ms，random→1 → 140ms，始终在 90–140ms 内", () => {
    expect(mouthDelayMs(0)).toBe(MOUTH_MIN_MS);
    expect(mouthDelayMs(0.999_999)).toBe(MOUTH_MAX_MS);
    for (const random of [0, 0.1, 0.33, 0.5, 0.7, 0.99, 1]) {
      const delay = mouthDelayMs(random);
      expect(delay).toBeGreaterThanOrEqual(MOUTH_MIN_MS);
      expect(delay).toBeLessThanOrEqual(MOUTH_MAX_MS);
    }
  });

  it("越界 random 被夹到 [0,1]", () => {
    expect(mouthDelayMs(-1)).toBe(MOUTH_MIN_MS);
    expect(mouthDelayMs(2)).toBe(MOUTH_MAX_MS);
  });
});
