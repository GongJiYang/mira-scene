import type { Action, Emotion, FaceLayers, Hands } from "@mira/protocol";
import { characterManifest } from "../render/manifest";
import { mouthFor } from "./mouth";

/**
 * 状态机 B：表演（D28）。纯 reducer，无定时器、无随机数、无 DOM。
 * 时钟事件（眨眼、口型节拍、待机小动作）由 core/performanceClock.ts 注入。
 */
export type Blink = "open" | "half" | "closed";

export type MouthShape = "closed" | "small" | "open";

/** A 的 phase 种类；与 state/types.ts 的 Phase["kind"] 一致，避免 B 依赖 A 的联合结构。 */
export type StagePhaseKind = "idle" | "listening" | "thinking" | "speaking" | "error";

/**
 * 开始播放的 beat 中 B 需要的字段。
 * A 在 BEAT_AUDIO_STARTED 时已把 beat 出队，只留下 visual，所以接线层从这里取 look。
 */
export type BeatLook = { emotion: Emotion; hands: Hands; action: Action | null };

/** 手部过渡进度（0–1），UI 用它做淡入淡出（D28：200ms 收回 cup）。 */
export type HandsTransition = { from: Hands; to: Hands; startedAt: number; progress: number };

export type ActiveAction = { action: Action; startedAt: number };

export type PerformanceState = {
  phase: StagePhaseKind;
  phaseSince: number;
  face: FaceLayers;
  blink: Blink;
  /** 眨眼脚本帧号：open → half → closed → half → open。 */
  blinkFrame: number;
  blinkFrameAt: number | null;
  mouth: MouthShape;
  hands: Hands;
  handsTransition: HandsTransition | null;
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
export const HANDS_TRANSITION_MS = 200;
export const THINKING_SIP_AFTER_MS = 2_000;
export const IDLE_ACTION_AFTER_MS = 8_000;
/** 待机小动作候选（D28：看窗外 / 喝咖啡 / 看手机）。 */
export const IDLE_ACTIONS: readonly Action[] = ["glance_window", "sip_coffee", "check_phone"];

/** idle 时第一次眨眼的窗口（含两端）。 */
export const BLINK_MIN_MS = 2_000;
export const BLINK_MAX_MS = 6_000;

const BLINK_SEQUENCE: readonly Blink[] = ["half", "closed", "half", "open"];

/** 动作 → 手部图层；glance_window 不改手部。 */
const ACTION_HANDS: Record<Action, Hands | null> = {
  sip_coffee: "cup",
  glance_window: null,
  check_phone: "phone",
  show_polaroid: "polaroid",
};

/** 返回副本：B 的 face 只在 reducer 里整体替换，避免和 manifest 共享可变数组。 */
export function faceForEmotion(emotion: Emotion): FaceLayers {
  const layers = characterManifest.emotions[emotion];
  return { base: layers.base, overlays: [...layers.overlays] };
}

/**
 * 「看镜头」：素材里没有单独的看镜头贴片，neutral 主立绘就是直视镜头。
 * listening 只要求面部直视 + 嘴闭合，因此用 neutral。
 */
export const CAMERA_FACE: FaceLayers = faceForEmotion("neutral");

/** thinking：eyelid_half（与 guarded 同一贴片，但不带其它情绪差分）。 */
export const THINKING_FACE: FaceLayers = { ...CAMERA_FACE, overlays: ["eyelid_half"] };

/** error：brow_raised（D28 映射表只要求眉毛，不带 surprised 的 mouth_o）。 */
export const ERROR_FACE: FaceLayers = { ...CAMERA_FACE, overlays: ["brow_raised"] };

export const initialPerformanceState: PerformanceState = {
  phase: "idle",
  phaseSince: 0,
  face: CAMERA_FACE,
  blink: "open",
  blinkFrame: 0,
  blinkFrameAt: null,
  mouth: "closed",
  hands: "cup",
  handsTransition: null,
  activeAction: null,
  idleSince: null,
  thinkingSipDone: false,
  idleActionDone: false,
};

function startHandsTransition(state: PerformanceState, to: Hands, at: number): PerformanceState {
  // 已经在目标图层：取消未完成的过渡即可，不需要再淡入。
  if (state.hands === to) return state.handsTransition === null ? state : { ...state, handsTransition: null };
  return { ...state, handsTransition: { from: state.hands, to, startedAt: at, progress: 0 } };
}

function applyPhase(state: PerformanceState, phase: StagePhaseKind, at: number): PerformanceState {
  if (state.phase === phase) {
    // 初始状态就是 idle（没有 phase 转移）：补记 idleSince，让待机计时有起点。
    if (phase === "idle" && state.idleSince === null) return { ...state, idleSince: at };
    return state;
  }
  switch (phase) {
    case "listening":
      // 打断：面部立即切到看镜头、嘴闭合；手部 200ms 平滑收回 cup。
      return startHandsTransition(
        {
          ...state,
          phase,
          phaseSince: at,
          face: CAMERA_FACE,
          blink: "open",
          blinkFrame: 0,
          blinkFrameAt: null,
          mouth: "closed",
          activeAction: null,
          idleSince: null,
          thinkingSipDone: false,
          idleActionDone: false,
        },
        "cup",
        at,
      );
    case "thinking":
      return {
        ...state,
        phase,
        phaseSince: at,
        face: THINKING_FACE,
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
        face: CAMERA_FACE,
        blink: "open",
        blinkFrame: 0,
        blinkFrameAt: null,
        mouth: "closed",
        idleSince: at,
        thinkingSipDone: false,
        idleActionDone: false,
      };
    case "error":
      return startHandsTransition(
        {
          ...state,
          phase,
          phaseSince: at,
          face: ERROR_FACE,
          blink: "open",
          blinkFrame: 0,
          blinkFrameAt: null,
          mouth: "closed",
          activeAction: null,
          idleSince: null,
          thinkingSipDone: false,
          idleActionDone: false,
        },
        "cup",
        at,
      );
  }
}

function applyBeatStarted(state: PerformanceState, look: BeatLook, at: number): PerformanceState {
  if (state.phase !== "speaking") return state;
  const hands = look.action === null ? look.hands : ACTION_HANDS[look.action] ?? state.hands;
  const withLook: PerformanceState = {
    ...state,
    face: faceForEmotion(look.emotion),
    mouth: "closed",
    activeAction: look.action === null ? null : { action: look.action, startedAt: at },
  };
  return withLook.hands === hands ? withLook : startHandsTransition(withLook, hands, at);
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

  // 手部过渡：200ms 线性进度，完成后落到目标图层。
  const transition = next.handsTransition;
  if (transition !== null) {
    const progress = Math.min(1, (at - transition.startedAt) / HANDS_TRANSITION_MS);
    if (progress >= 1) {
      next = { ...next, hands: transition.to, handsTransition: null };
    } else if (progress !== transition.progress) {
      next = { ...next, handsTransition: { ...transition, progress } };
    }
  }

  // thinking 超过 2s：补一次抿咖啡（每次 thinking 只补一次）。
  if (next.phase === "thinking" && !next.thinkingSipDone && at - next.phaseSince >= THINKING_SIP_AFTER_MS) {
    next = {
      ...next,
      thinkingSipDone: true,
      activeAction: { action: "sip_coffee", startedAt: at },
      hands: "cup",
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
      const hands = ACTION_HANDS[action.action];
      return {
        ...state,
        idleActionDone: true,
        activeAction: { action: action.action, startedAt: action.at },
        hands: hands ?? state.hands,
      };
    }
  }
}
