import { create } from "zustand";
import { createConnection, type Connection } from "./connection";
import { installPerformanceClock } from "./performanceClock";
import { blobToBase64, createRecorder, type Recorder } from "./recorder";
import { reactionSfx } from "./reactionSfx";
import { dispatch, getStageState, pushEvent } from "./store";
import { installStoryMediaLink } from "./storyMediaLink";

export type Intents = {
  pttDown(): void;
  pttUp(): void;
  submitText(text: string): void;
  retry(): void;
};

export type ControllerDeps = { connection: Connection; recorder: Recorder };

type NudgeSlice = { pending: boolean };

/** D32 主动行动：本批只记录，不发送到服务端（S3 再接）。 */
export const useNudgeStore = create<NudgeSlice>()(() => ({ pending: false }));

export function recordNudge(at: number): void {
  useNudgeStore.setState({ pending: true });
  pushEvent(`nudge@${at} · 12s 无输入，主动行动挂起（未发送）`);
}

export function createController({ connection, recorder }: ControllerDeps): Intents {
  return {
    pttDown() {
      const { currentTurnId, phase } = getStageState();
      const wasActive = phase.kind !== "idle";
      pushEvent(`ptt down t${currentTurnId}`);
      if (useNudgeStore.getState().pending) useNudgeStore.setState({ pending: false });
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
      if (useNudgeStore.getState().pending) useNudgeStore.setState({ pending: false });
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

export function bootstrapConnection(): void {
  // 表演时钟（B）与剧情媒体（C）的接线都在这里启动：UI 只经由视图模型读状态。
  installPerformanceClock({ onNudge: recordNudge });
  installStoryMediaLink();
  connection.connect();
}
