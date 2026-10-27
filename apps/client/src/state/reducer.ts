import type { Beat, SceneState, ServerMessage } from "@mira/protocol";
import type { ClientAction, ClientState, Phase } from "./types";

export const initialState: ClientState = {
  phase: { kind: "idle" },
  currentTurnId: 0,
  queue: [],
  turnEnded: false,
  subtitle: null,
  visual: { emotion: "neutral", hands: "cup", action: null, camera: null, fx: null, accent: null },
  media: null,
  audioStopToken: 0,
  node: "arrive",
};

/**
 * 打断入口（PTT_DOWN / SUBMIT_TEXT 共用）：整轮作废，turnId 只自增一次。
 */
function beginTurn(state: ClientState, phase: Phase): ClientState {
  return {
    ...state,
    phase,
    currentTurnId: state.currentTurnId + 1,
    queue: [],
    turnEnded: false,
    subtitle: null,
    media: null,
    audioStopToken: state.audioStopToken + 1,
  };
}

function enqueueBeat(state: ClientState, beat: Beat): ClientState {
  if (state.queue.some((queued) => queued.seq === beat.seq)) return state;
  return {
    ...state,
    queue: [...state.queue, beat].sort((left, right) => left.seq - right.seq),
  };
}

/**
 * 统一回到 idle 的清理：subtitle 与 queue 一并清空。
 * media 不清理——媒体生命周期在 S4 定义。
 */
function toIdle(state: ClientState): ClientState {
  return { ...state, phase: { kind: "idle" }, queue: [], subtitle: null };
}

/**
 * turn_end 规则：
 * - thinking 且 queue 为空（本轮没有任何 beat）：直接 idle。
 * - speaking：只置 turnEnded，等最后一个 BEAT_AUDIO_ENDED 再回 idle；
 *   最后一个 beat 在 STARTED 时已出队，但音频还在播放。
 * - 其他 phase：只置 turnEnded。
 */
function markTurnEnded(state: ClientState): ClientState {
  if (state.phase.kind === "thinking" && state.queue.length === 0) {
    return { ...toIdle(state), turnEnded: true };
  }
  return { ...state, turnEnded: true };
}

function applySnapshot(state: ClientState, snapshot: SceneState): ClientState {
  return {
    ...state,
    // S6l §2：剧情阶段只认服务端下发的当前节点。
    node: snapshot.node,
    visual: {
      ...state.visual,
      emotion: snapshot.emotion,
      hands: snapshot.hands,
      camera: snapshot.camera,
      fx: snapshot.fx,
    },
  };
}

function applyServerMessage(state: ClientState, message: ServerMessage): ClientState {
  // 恢复会话：服务端 lastTurnId 可能大于本地计数器（例如刷新页面）。
  // turnId 同步必须在 reducer 内完成（D4），且只前进不回退（D12）。
  if (message.type === "session") {
    return {
      ...applySnapshot(state, message.payload.snapshot),
      currentTurnId: Math.max(state.currentTurnId, message.turnId),
    };
  }
  if (message.type === "state_snapshot") {
    return applySnapshot(state, message.payload.snapshot);
  }

  // 剧情层消息（D27）与心跳：不按 turnId 过滤，本批原样忽略；C 状态机与心跳在 G1-c。
  // S6c §5：scene_status 也是剧情层消息，不经过 A 的 turnId 过滤。
  if (message.type === "media_ready" || message.type === "pong" || message.type === "scene_status") return state;

  // S6b-fix3 §1：只有会话级 error（scope === "session"）跳过 turnId 过滤；
  // 轮次级 error（llm_timeout / turn_failed 等）回到 D3 过滤之后——
  // 打断一轮后旧轮次迟到的 error 不得把界面切进错误态（D3 / Q1 打断语义）。
  if (message.type === "error" && message.payload.scope === "session") {
    return {
      ...toIdle(state),
      phase: {
        kind: "error",
        code: message.payload.code,
        message: message.payload.message,
        retryable: message.payload.retryable,
      },
      audioStopToken: state.audioStopToken + 1,
    };
  }

  // D3：客户端按 turnId 过滤是唯一正确性保证；不属于本轮的消息一律丢弃。
  if (message.turnId !== state.currentTurnId) return state;

  switch (message.type) {
    case "beat":
      return enqueueBeat(state, message.payload.beat);
    case "turn_end":
      return markTurnEnded(state);
    case "error":
      return {
        ...toIdle(state),
        phase: {
          kind: "error",
          code: message.payload.code,
          message: message.payload.message,
          retryable: message.payload.retryable,
        },
        audioStopToken: state.audioStopToken + 1,
      };
    case "transcript":
    case "tts_audio":
      return state;
  }
}

function applyBeatStarted(state: ClientState, turnId: number, seq: number): ClientState {
  if (turnId !== state.currentTurnId) return state;
  const beat = state.queue.find((queued) => queued.seq === seq);
  if (!beat) return state;

  return {
    ...state,
    queue: state.queue.filter((queued) => queued.seq !== seq),
    subtitle: beat.say,
    // S6l §2：带剧情推进的 beat 一到就更新当前节点（只认服务端）。
    node: beat.story?.advance ?? state.node,
    visual: {
      emotion: beat.emotion,
      hands: beat.hands,
      action: beat.action ?? state.visual.action,
      camera: beat.camera ?? state.visual.camera,
      fx: beat.fx ?? state.visual.fx,
      // D47：accent 是逐句的（只在被切分的第一个 beat 上），下一句为 null 时立即清掉。
      accent: beat.accent,
    },
    media: beat.media ?? state.media,
    phase: { kind: "speaking", seq },
  };
}

/**
 * BEAT_AUDIO_ENDED 规则：
 * - queue 非空：本句播完，保持 speaking(seq)，等下一个 BEAT_AUDIO_STARTED。
 * - queue 为空且 turnEnded：整轮结束，回 idle。
 * - queue 为空且未 turnEnded：服务端可能还在生成下一句，回 thinking 并清空字幕。
 */
function applyBeatEnded(state: ClientState, turnId: number): ClientState {
  if (turnId !== state.currentTurnId) return state;
  if (state.queue.length > 0) return state;
  if (state.turnEnded) return toIdle(state);
  return { ...state, phase: { kind: "thinking" }, subtitle: null };
}

export function reducer(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case "PTT_DOWN":
      return beginTurn(state, { kind: "listening" });
    case "PTT_UP":
      return state.phase.kind === "listening" ? { ...state, phase: { kind: "thinking" } } : state;
    case "SUBMIT_TEXT":
      return beginTurn(state, { kind: "thinking" });
    case "NUDGE":
      // D32：主动开口按一次新输入处理（turnId 递增、整轮作废重来）。
      return beginTurn(state, { kind: "thinking" });
    case "SERVER_MESSAGE":
      return applyServerMessage(state, action.message);
    case "BEAT_AUDIO_STARTED":
      return applyBeatStarted(state, action.turnId, action.seq);
    case "BEAT_AUDIO_ENDED":
      return applyBeatEnded(state, action.turnId);
    case "INPUT_CANCELLED":
      // 本轮没有上行输入（短按 / 麦克风失败）：listening / thinking 回到 idle。
      // 旧轮次或其它 phase 原样返回同一个引用；currentTurnId 不回退。
      return action.turnId === state.currentTurnId &&
        (state.phase.kind === "listening" || state.phase.kind === "thinking")
        ? toIdle(state)
        : state;
    case "RETRY":
      return state.phase.kind === "error" ? toIdle(state) : state;
    case "RESET":
      // S6b §4：切频道不保留聊天记录 —— 整台状态机回到初始值。
      return initialState;
  }
}

export function nextBeatToPlay(state: ClientState): Beat | null {
  let next: Beat | null = null;
  for (const beat of state.queue) {
    if (next === null || beat.seq < next.seq) next = beat;
  }
  return next;
}
