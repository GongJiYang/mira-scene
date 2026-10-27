import type { Media } from "@mira/protocol";
import { create } from "zustand";
import { forceMouthClosed, isAudioPlaying, isReactionActive, stopPlaybackNow } from "./audio";
import { createConnection, type Connection } from "./connection";
import { installOfflineFallbackFor, useFallbackStore } from "./fallback";
import { createInterruptExecutor, type InterruptReason } from "./interrupt";
import { installPerformanceClock, usePerformanceStore } from "./performanceClock";
import { blobToBase64, createRecorder, type Recorder } from "./recorder";
import { reactionSfx } from "./reactionSfx";
import { dispatch, getStageState, pushEvent, useConnectionStore } from "./store";
import { dispatchStoryMedia, installStoryMediaLink } from "./storyMediaLink";
import { timeline, pushTimelineLog, timelineCountForTurn, timelineStoryCount } from "./timeline";
import { initialNudgeLimitState, nudgeLimit, type NudgeLimitState } from "../state/nudge";
import { characterOrDefault } from "../live/characters";
import { setChannel, useChannelStore } from "../live/channel";
import { resetSceneStatus } from "../live/scene/status";
import { installSceneFallback, resetSceneFallback } from "../live/scene/sceneFallback";
import { initialPerformanceState } from "../state/performance";

export type Intents = {
  pttDown(): void;
  pttUp(): void;
  submitText(text: string): void;
  retry(): void;
  /**
   * S6b §4：切换频道。进行中的一轮按打断处理（D34），以新 characterId 重新 hello，
   * **不保留**聊天记录。
   */
  switchChannel(characterId: string): void;
};

export type ControllerDeps = { connection: Connection; recorder: Recorder };

type NudgeSlice = { pending: boolean; limit: NudgeLimitState };

/** D32 主动开口：频率限制状态 + 视图模型的提示标记。 */
export const useNudgeStore = create<NudgeSlice>()(() => ({ pending: false, limit: initialNudgeLimitState }));

/** Q8：图片加载失败时替换用的另一张预置照片。 */
const FALLBACK_PHOTO: Media = { type: "photo", id: "photo_rain_street", url: "/stage/photos/photo_rain_street.png" };

/** 渲染层的唯一例外：C 状态机的图片加载结果回调，必须经过 controller。 */
export type StageReports = { mediaLoadFailed(storyEventId: string): void };

export const reports: StageReports = {
  mediaLoadFailed(storyEventId) {
    pushEvent(`media load failed ${storyEventId} → fallback`);
    dispatchStoryMedia({ type: "IMAGE_FAILED", storyEventId, media: FALLBACK_PHOTO });
  },
};

/** 用户开口：连续计数归零（§7）。间隔限制仍然有效，避免刚说完就抢话。 */
function userSpoke(): void {
  const decision = nudgeLimit(useNudgeStore.getState().limit, { type: "USER_SPEAK" });
  useNudgeStore.setState({ pending: false, limit: decision.state });
}

export function createController({ connection, recorder }: ControllerDeps): Intents {
  // D34：打断有序执行器（同一帧内同步、按 interruptPlan 逐步执行 + 打点 + 写环形缓冲 + 校验后置条件）。
  const performInterrupt = createInterruptExecutor({
    now: () => timeline.now(),
    stopAudio: () => {
      stopPlaybackNow();
      reactionSfx()?.stop();
    },
    forceMouthClosed,
    cancelTurn: (turnId) => timeline.cancelTurn(turnId),
    clearState: (reason: InterruptReason) => dispatch({ type: reason === "ptt" ? "PTT_DOWN" : "SUBMIT_TEXT" }),
    confirmListening: () => pushEvent("interrupt · 倾听态由 B 从 phase 推导"),
    sendInterrupt: (turnId) => connection.sendInterrupt(turnId),
    mark: (name) => {
      if (typeof performance !== "undefined" && typeof performance.mark === "function") performance.mark(name);
    },
    log: (entry) => pushTimelineLog({ t: entry.t, kind: "interrupt", key: entry.step, turnId: entry.turnId }),
    audioPlaying: () => isAudioPlaying(),
    reactionActive: () => isReactionActive(),
    mouth: () => usePerformanceStore.getState().mouth,
    subtitle: () => getStageState().subtitle,
    oldTurnCommandCount: (turnId) => timelineCountForTurn(timeline.state(), turnId),
    storyCommandCount: () => timelineStoryCount(timeline.state()),
    reportViolations: (violations, turnId) => {
      const message = `[interrupt] 后置条件未满足 t${turnId}：${violations.join("；")}`;
      console.error(message);
      pushEvent(message);
    },
  });

  return {
    pttDown() {
      const { currentTurnId, phase } = getStageState();
      const wasActive = phase.kind !== "idle";
      pushEvent(`ptt down t${currentTurnId}`);
      userSpoke();
      if (wasActive) {
        // 会打断：走有序执行器（清音频 / 闭嘴 / 清空时间线与字幕 / 发 interrupt）。
        performInterrupt("ptt", currentTurnId);
      } else {
        dispatch({ type: "PTT_DOWN" });
      }
      const turnId = getStageState().currentTurnId;
      void recorder.start().then((started) => {
        if (started) return;
        // 麦克风被拒绝 / 不可用：本轮没有上行输入，回到 idle，否则会卡在 listening。
        pushEvent(`ptt down · 麦克风不可用，取消 t${turnId}`);
        dispatch({ type: "INPUT_CANCELLED", turnId });
      });
    },

    pttUp() {
      dispatch({ type: "PTT_UP" });
      const afterUp = getStageState();
      // §5：进入 thinking 后 150ms 内随机播一条反应音。
      if (afterUp.phase.kind === "thinking") reactionSfx()?.arm(afterUp.currentTurnId);
      const turnId = afterUp.currentTurnId;
      void (async () => {
        const recording = await recorder.stop();
        if (!recording) {
          // 短按（<300ms）、空 Blob 或录音器失败：不发送 audio_input，回到 idle。
          pushEvent(`ptt up · 录音过短或无数据，已丢弃 t${turnId}`);
          dispatch({ type: "INPUT_CANCELLED", turnId });
          return;
        }
        connection.sendAudio(recording.mime, await blobToBase64(recording.blob));
      })();
    },

    submitText(text) {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      const { currentTurnId, phase } = getStageState();
      const wasActive = phase.kind !== "idle";
      pushEvent(`submit t${currentTurnId}`);
      userSpoke();
      if (wasActive) {
        // 会打断：走有序执行器（清音频 / 闭嘴 / 清空时间线与字幕 / 发 interrupt）。
        performInterrupt("text", currentTurnId);
      } else {
        dispatch({ type: "SUBMIT_TEXT" });
      }
      // §5：进入 thinking 后 150ms 内随机播一条反应音。
      reactionSfx()?.arm(getStageState().currentTurnId);
      connection.sendText(trimmed);
    },

    retry() {
      pushEvent("retry");
      dispatch({ type: "RETRY" });
    },

    switchChannel(characterId) {
      const { currentTurnId, phase } = getStageState();
      pushEvent(`switch channel → ${characterId}`);
      // 进行中的一轮按打断处理（D34）：停音频、闭嘴、清时间线、发 interrupt。
      if (phase.kind !== "idle") performInterrupt("text", currentTurnId);
      // 不保留聊天记录：A 回到初始值；B / C 与兜底字幕一并复位。
      // S6c §5：换背景状态也复位（切频道 → 取消并丢弃该会话的任务）。
      dispatch({ type: "RESET" });
      usePerformanceStore.setState(initialPerformanceState);
      dispatchStoryMedia({ type: "PHASE", phase: "idle" });
      useFallbackStore.setState({ subtitle: null });
      resetSceneStatus();
      // S6c-fix1 §2：切频道丢弃待播的换背景兜底。
      resetSceneFallback();
      setChannel(characterId);
      connection.switchCharacter?.(characterId);
    },
  };
}

const connection = createConnection();
const recorder = createRecorder();

/** 视图模型只暴露这 4 个意图（D14）。 */
export const intents: Intents = createController({ connection, recorder });

/** S6f §2：当前麦克风输入音量（0–1），倾听声波据此跳动；未录音时为 0。 */
export function micInputLevel(): number {
  return recorder.level();
}

/**
 * D32：B 产出 nudge 时调用。A 为 idle 且连接正常、且未超频率限制时才发送；
 * turnId 递增，服务端按一次新输入处理（不计入 trust / 限额）。
 */
export function recordNudge(at: number): void {
  const stage = getStageState();
  if (stage.phase.kind !== "idle" || useConnectionStore.getState().status !== "open") {
    pushEvent(`nudge@${at} · 条件不满足（phase=${stage.phase.kind}），未发送`);
    return;
  }
  const decision = nudgeLimit(useNudgeStore.getState().limit, { type: "NUDGE", at });
  if (!decision.send) {
    useNudgeStore.setState({ pending: true, limit: decision.state });
    pushEvent(`nudge@${at} · 频率限制（${decision.reason}），未发送`);
    return;
  }
  useNudgeStore.setState({ pending: false, limit: decision.state });
  pushEvent(`nudge@${at} · 主动开口 t${stage.currentTurnId + 1}`);
  dispatch({ type: "NUDGE" });
  connection.sendNudge?.();
}

export function bootstrapConnection(): void {
  // 表演时钟（B）与剧情媒体（C）的接线都在这里启动：UI 只经由视图模型读状态。
  installPerformanceClock({ onNudge: recordNudge });
  installStoryMediaLink();
  // S6c-fix1 §2：换背景失败 / 拒绝的兜底走剧情层——空档播放本地预录 + 字幕。
  installSceneFallback({
    characterId: () => characterOrDefault(useChannelStore.getState().characterId).id,
    showSubtitle: (text) => useFallbackStore.setState({ subtitle: text }),
  });
  // S6b §2：断线时由客户端本地播 offline 兜底（服务端此时发不出消息）。
  installOfflineFallbackFor(
    () => characterOrDefault(useChannelStore.getState().characterId).id,
    () => characterOrDefault(useChannelStore.getState().characterId).offlineLine,
  );
  connection.connect();
}
