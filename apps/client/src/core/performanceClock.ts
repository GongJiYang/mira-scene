import { create } from "zustand";
import { getStageState, useStageStore } from "./store";
import { timeline } from "./timeline";
import {
  BLINK_MAX_MS,
  BLINK_MIN_MS,
  IDLE_ACTION_AFTER_MS,
  IDLE_ACTIONS,
  initialPerformanceState,
  performanceReducer,
  type PerformanceAction,
  type PerformanceState,
  type StagePhaseKind,
} from "../state/performance";

/** 心跳节拍：60ms 一帧，够 UI 用（每帧约一次状态更新）。 */
export const PERFORMANCE_TICK_MS = 60;
export const MOUTH_MIN_MS = 90;
export const MOUTH_MAX_MS = 140;
/** D32：idle 且用户 12s 无输入 → nudge。 */
export const NUDGE_AFTER_MS = 12_000;

/** 说话口型切换间隔：90–140ms，用独立定时器保证不被 60ms 节拍量化。 */
export function mouthDelayMs(random: number): number {
  const clamped = Math.min(Math.max(random, 0), 1);
  return Math.round(MOUTH_MIN_MS + clamped * (MOUTH_MAX_MS - MOUTH_MIN_MS));
}

export const usePerformanceStore = create<PerformanceState>()(() => initialPerformanceState);

export function dispatchPerformance(action: PerformanceAction): void {
  usePerformanceStore.setState((state) => performanceReducer(state, action));
}

export type PerformanceClockDeps = {
  now: () => number;
  rng: () => number;
  getPhase: () => StagePhaseKind;
  getPerformance: () => PerformanceState;
  emit: (action: PerformanceAction) => void;
  onNudge: (at: number) => void;
};

export type PerformanceClock = { tick: () => void };

/**
 * 纯调度：随机数与时间都注入，tick 由外部驱动（浏览器里是 60ms 的 setInterval）。
 * 只决定「什么时候」发生（眨眼、待机小动作、nudge），不决定状态如何转移。
 * 说话口型用独立定时器（90–140ms），避免被 60ms 节拍量化。
 */
export function createPerformanceClock(deps: PerformanceClockDeps): PerformanceClock {
  let lastPhase: StagePhaseKind | null = null;
  let nextBlinkAt: number | null = null;
  let nudgeForIdleSince: number | null = null;

  function onPhaseChange(): void {
    nextBlinkAt = null;
    nudgeForIdleSince = null;
  }

  return {
    tick() {
      const at = deps.now();
      const phase = deps.getPhase();
      if (phase !== lastPhase) {
        lastPhase = phase;
        onPhaseChange();
      }

      deps.emit({ type: "TICK", at });
      const performance = deps.getPerformance();

      if (phase === "idle") {
        const idleSince = performance.idleSince ?? at;
        nextBlinkAt ??= idleSince + BLINK_MIN_MS + deps.rng() * (BLINK_MAX_MS - BLINK_MIN_MS);
        if (at >= nextBlinkAt) {
          deps.emit({ type: "BLINK", at });
          nextBlinkAt = at + BLINK_MIN_MS + deps.rng() * (BLINK_MAX_MS - BLINK_MIN_MS);
        }
        if (!performance.idleActionDone && at - idleSince >= IDLE_ACTION_AFTER_MS) {
          const index = Math.floor(deps.rng() * IDLE_ACTIONS.length);
          deps.emit({ type: "IDLE_ACTION", action: IDLE_ACTIONS[index] ?? "glance_window", at });
        }
        if (nudgeForIdleSince !== idleSince && at - idleSince >= NUDGE_AFTER_MS) {
          nudgeForIdleSince = idleSince;
          deps.onNudge(at);
        }
      }
    },
  };
}

let installedCleanup: (() => void) | null = null;

/**
 * 浏览器接线：把 A 的 phase / beat 起点喂给 B，节拍（60ms）与 nudge 计时都交给
 * 统一的时间线（`core/timeline.ts`）驱动。
 * 幂等：重复调用返回同一个清理函数。
 */
export function installPerformanceClock(options: { onNudge?: (at: number) => void } = {}): () => void {
  if (installedCleanup) return installedCleanup;

  const clock = createPerformanceClock({
    now: () => Date.now(),
    rng: Math.random,
    getPhase: () => getStageState().phase.kind,
    getPerformance: () => usePerformanceStore.getState(),
    emit: dispatchPerformance,
    // D34：nudge 计时改由统一的时间线负责，这里不再自行触发。
    onNudge: () => {},
  });

  // 初始 A 就是 idle：补一次 PHASE，让 B 的 idleSince 从启动时刻算起。
  dispatchPerformance({ type: "PHASE", phase: getStageState().phase.kind, at: Date.now() });

  // 唯一节拍：60ms 一次的表演时钟由时间线驱动（不再是 setInterval）。
  function scheduleTick(): void {
    timeline.schedule({
      key: "performance:tick",
      atMs: timeline.now() + PERFORMANCE_TICK_MS,
      run: () => {
        clock.tick();
        scheduleTick();
      },
    });
  }
  scheduleTick();

  // D34：idle 满 12s → 主动开口；离开 idle 立即取消（计时交给时间线）。
  function scheduleNudge(): void {
    timeline.cancelKey("nudge");
    if (getStageState().phase.kind !== "idle") return;
    timeline.schedule({
      key: "nudge",
      atMs: timeline.now() + NUDGE_AFTER_MS,
      run: () => options.onNudge?.(timeline.now()),
    });
  }

  let lastPhaseKind = getStageState().phase.kind;
  let lastSpeakingSeq: number | null = null;
  const unsubscribe = useStageStore.subscribe((state) => {
    const kind = state.phase.kind;
    const at = Date.now();
    if (kind !== lastPhaseKind) {
      lastPhaseKind = kind;
      dispatchPerformance({ type: "PHASE", phase: kind, at });
      scheduleNudge();
    }
    if (kind === "speaking" && state.phase.kind === "speaking") {
      const seq = state.phase.seq;
      if (lastSpeakingSeq !== seq) {
        lastSpeakingSeq = seq;
        dispatchPerformance({
          type: "BEAT_STARTED",
          look: {
            emotion: state.visual.emotion,
            hands: state.visual.hands,
            action: state.visual.action,
          },
          at,
        });
      }
    } else {
      lastSpeakingSeq = null;
    }
  });

  scheduleNudge();

  installedCleanup = () => {
    timeline.cancelKey("performance:tick");
    timeline.cancelKey("nudge");
    unsubscribe();
    installedCleanup = null;
  };
  return installedCleanup;
}
