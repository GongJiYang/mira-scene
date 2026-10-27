import type { Media } from "@mira/protocol";
import { create } from "zustand";
import { createConnection, type Connection } from "./connection";
import { installPerformanceClock } from "./performanceClock";
import { blobToBase64, createRecorder, type Recorder } from "./recorder";
import { reactionSfx } from "./reactionSfx";
import { dispatch, getStageState, pushEvent, useConnectionStore } from "./store";
import { dispatchStoryMedia, installStoryMediaLink } from "./storyMediaLink";
import { initialNudgeLimitState, nudgeLimit, type NudgeLimitState } from "../state/nudge";

export type Intents = {
  pttDown(): void;
  pttUp(): void;
  submitText(text: string): void;
  retry(): void;
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
  return {
    pttDown() {
      const { currentTurnId, phase } = getStageState();
      const wasActive = phase.kind !== "idle";
      pushEvent(`ptt down t${currentTurnId}`);
      userSpoke();
      dispatch({ type: "PTT_DOWN" });
      if (wasActive) connection.sendInterrupt(currentTurnId);
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
      dispatch({ type: "SUBMIT_TEXT" });
      // §5：进入 thinking 后 150ms 内随机播一条反应音。
      reactionSfx()?.arm(getStageState().currentTurnId);
      if (wasActive) connection.sendInterrupt(currentTurnId);
      connection.sendText(trimmed);
    },

    retry() {
      pushEvent("retry");
      dispatch({ type: "RETRY" });
    },
  };
}

const connection = createConnection();
const recorder = createRecorder();

/** 视图模型只暴露这 4 个意图（D14）。 */
export const intents: Intents = createController({ connection, recorder });

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
  connection.connect();
}
