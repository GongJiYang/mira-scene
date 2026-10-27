import type { Action, Emotion } from "@mira/protocol";
import { mouthFor } from "./mouth";

/**
 * 状态机 B：表演（D28）。纯 reducer，无定时器、无随机数、无 DOM。
 * 时钟事件（眨眼、口型节拍、待机小动作）由 core/performanceClock.ts 注入。
 *
 * D43（S6g-A）：删掉分层立绘后，B 只保留忧奈 Live2D 舞台真正消费的字段
 * （phase / blink / mouth / activeAction / idleSince）。原 `face` / `hands` /
 * `handsTransition` 只服务夏凛的贴片图层，已删除。
 */
export type Blink = "open" | "half" | "closed";

export type MouthShape = "closed" | "small" | "open";

/** A 的 phase 种类；与 state/types.ts 的 Phase["kind"] 一致，避免 B 依赖 A 的联合结构。 */
export type StagePhaseKind = "idle" | "listening" | "thinking" | "speaking" | "error";

/**
 * 开始播放的 beat 中 B 需要的字段。
 * A 在 BEAT_AUDIO_STARTED 时已把 beat 出队，只留下 visual，所以接线层从这里取 look。
 */
export type BeatLook = { emotion: Emotion; action: Action | null };

export type ActiveAction = { action: Action; startedAt: number };

export type PerformanceState = {
  phase: StagePhaseKind;
  phaseSince: number;
  blink: Blink;
  /** 眨眼脚本帧号：open → half → closed → half → open。 */
  blinkFrame: number;
  blinkFrameAt: number | null;
  mouth: MouthShape;
  activeAction: ActiveAction | null;
  /** 进入 idle 的时刻；null 表示当前不在 idle。 */
  idleSince: number | null;
  thinkingSipDone: boolean;
  idleActionDone: boolean;
};

export type PerformanceAction =
  | { type: "PHASE"; phase: StagePhaseKind; at: number }
  | { type: "BEAT_STARTED"; look: BeatLook; at: number }
  | { type: "TICK"; at: number }
  | { type: "BLINK"; at: number }
  /** D34：音量驱动的口型。形状由 `mouthFor(phase, audioPlaying, shape)` 推导。 */
  | { type: "MOUTH"; shape: MouthShape; audioPlaying: boolean }
  | { type: "IDLE_ACTION"; action: Action; at: number };

export const BLINK_FRAME_MS = 60;
export const THINKING_SIP_AFTER_MS = 2_000;
export const IDLE_ACTION_AFTER_MS = 8_000;
/** 待机小动作候选（D28：瞟一眼 / 喝一口 / 看手机）。 */
export const IDLE_ACTIONS: readonly Action[] = ["glance", "drink", "phone"];

/** idle 时第一次眨眼的窗口（含两端）。 */
export const BLINK_MIN_MS = 2_000;
export const BLINK_MAX_MS = 6_000;

const BLINK_SEQUENCE: readonly Blink[] = ["half", "closed", "half", "open"];

export const initialPerformanceState: PerformanceState = {
  phase: "idle",
  phaseSince: 0,
  blink: "open",
  blinkFrame: 0,
  blinkFrameAt: null,
  mouth: "closed",
  activeAction: null,
  idleSince: null,
  thinkingSipDone: false,
  idleActionDone: false,
};

function applyPhase(state: PerformanceState, phase: StagePhaseKind, at: number): PerformanceState {
  if (state.phase === phase) {
    // 初始状态就是 idle（没有 phase 转移）：补记 idleSince，让待机计时有起点。
    if (phase === "idle" && state.idleSince === null) return { ...state, idleSince: at };
    return state;
  }
  switch (phase) {
    case "listening":
      // 打断：面部立即切到看镜头、嘴闭合；清空动作。
      return {
        ...state,
        phase,
        phaseSince: at,
        blink: "open",
        blinkFrame: 0,
        blinkFrameAt: null,
        mouth: "closed",
        activeAction: null,
        idleSince: null,
        thinkingSipDone: false,
        idleActionDone: false,
      };
    case "thinking":
      return {
        ...state,
        phase,
        phaseSince: at,
        blink: "open",
        blinkFrame: 0,
        blinkFrameAt: null,
        mouth: "closed",
        idleSince: null,
        thinkingSipDone: false,
        idleActionDone: false,
      };
    case "speaking":
      return {
        ...state,
        phase,
        phaseSince: at,
        mouth: "closed",
        idleSince: null,
        thinkingSipDone: false,
        idleActionDone: false,
      };
    case "idle":
      return {
        ...state,
        phase,
        phaseSince: at,
        blink: "open",
        blinkFrame: 0,
        blinkFrameAt: null,
        mouth: "closed",
        idleSince: at,
        thinkingSipDone: false,
        idleActionDone: false,
      };
    case "error":
      return {
        ...state,
        phase,
        phaseSince: at,
        blink: "open",
        blinkFrame: 0,
        blinkFrameAt: null,
        mouth: "closed",
        activeAction: null,
        idleSince: null,
        thinkingSipDone: false,
        idleActionDone: false,
      };
  }
}

function applyBeatStarted(state: PerformanceState, look: BeatLook, at: number): PerformanceState {
  if (state.phase !== "speaking") return state;
  return {
    ...state,
    mouth: "closed",
    activeAction: look.action === null ? null : { action: look.action, startedAt: at },
  };
}

function applyTick(state: PerformanceState, at: number): PerformanceState {
  let next = state;

  // 眨眼：每帧约 60ms，最后一帧 open 结束脚本。
  if (next.blinkFrameAt !== null && at - next.blinkFrameAt >= BLINK_FRAME_MS) {
    const frame = next.blinkFrame + 1;
    const shape = BLINK_SEQUENCE[frame] ?? "open";
    next =
      frame >= BLINK_SEQUENCE.length - 1
        ? { ...next, blink: "open", blinkFrame: 0, blinkFrameAt: null }
        : { ...next, blink: shape, blinkFrame: frame, blinkFrameAt: at };
  }

  // thinking 超过 2s：补一次抿咖啡（每次 thinking 只补一次）。
  if (next.phase === "thinking" && !next.thinkingSipDone && at - next.phaseSince >= THINKING_SIP_AFTER_MS) {
    next = {
      ...next,
      thinkingSipDone: true,
      activeAction: { action: "drink", startedAt: at },
    };
  }

  return next;
}

export function performanceReducer(state: PerformanceState, action: PerformanceAction): PerformanceState {
  switch (action.type) {
    case "PHASE":
      return applyPhase(state, action.phase, action.at);
    case "BEAT_STARTED":
      return applyBeatStarted(state, action.look, action.at);
    case "TICK":
      return applyTick(state, action.at);
    case "BLINK":
      // 只有待机时按随机间隔眨眼；其它 phase 忽略。
      if (state.phase !== "idle") return state;
      return { ...state, blink: "half", blinkFrame: 0, blinkFrameAt: action.at };
    case "MOUTH": {
      // D34：口型由 mouthFor 推导；非 speaking 或音频没播放时一律 closed。
      const mouth = mouthFor(state.phase, action.audioPlaying, action.shape);
      return mouth === state.mouth ? state : { ...state, mouth };
    }
    case "IDLE_ACTION": {
      if (state.phase !== "idle" || state.idleActionDone) return state;
      return {
        ...state,
        idleActionDone: true,
        activeAction: { action: action.action, startedAt: action.at },
      };
    }
  }
}
