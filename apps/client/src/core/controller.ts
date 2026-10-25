import { createConnection, type Connection } from "./connection";
import { blobToBase64, createRecorder, type Recorder } from "./recorder";
import { dispatch, getStageState, pushEvent } from "./store";

export type Intents = {
  pttDown(): void;
  pttUp(): void;
  submitText(text: string): void;
  retry(): void;
};

export type ControllerDeps = { connection: Connection; recorder: Recorder };

export function createController({ connection, recorder }: ControllerDeps): Intents {
  return {
    pttDown() {
      const { currentTurnId, phase } = getStageState();
      const wasActive = phase.kind !== "idle";
      pushEvent(`ptt down t${currentTurnId}`);
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
      const turnId = getStageState().currentTurnId;
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
      dispatch({ type: "SUBMIT_TEXT" });
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
  connection.connect();
}
