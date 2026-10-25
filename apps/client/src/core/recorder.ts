import { useMicStore } from "./store";

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4"] as const;
const MIN_RECORDING_MS = 300;

export type Recording = { blob: Blob; mime: string; durationMs: number };

export type Recorder = {
  /** 开始录音；权限被拒绝或不可用时返回 false，并把原因写入 micError slice。 */
  start(): Promise<boolean>;
  /** 停止录音；不足 300ms（误触）、没有数据或录音器出错时返回 null。 */
  stop(): Promise<Recording | null>;
};

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function createRecorder(): Recorder {
  let mediaRecorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  let starting: Promise<boolean> | null = null;
  // MediaRecorder 的 error 事件：本轮录音不可用，stop() 一律返回 null。
  let failed = false;
  // stop() 早于 getUserMedia 完成时置位：避免用户松开后才开始录音。
  let cancelled = false;

  function begin(): Promise<boolean> {
    if (starting) {
      cancelled = false;
      return starting;
    }
    cancelled = false;
    const attempt = (async () => {
      try {
        const nextStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          nextStream.getTracks().forEach((track) => track.stop());
          return false;
        }
        stream = nextStream;
        const mimeType = MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
        mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        chunks = [];
        failed = false;
        mediaRecorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        });
        mediaRecorder.addEventListener("error", () => {
          failed = true;
        });
        mediaRecorder.start();
        startedAt = performance.now();
        useMicStore.setState({ micError: null });
        return true;
      } catch (error) {
        useMicStore.setState({ micError: error instanceof Error ? error.message : "麦克风权限被拒绝" });
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        mediaRecorder = null;
        return false;
      } finally {
        starting = null;
      }
    })();
    starting = attempt;
    return attempt;
  }

  return {
    start() {
      if (mediaRecorder) return Promise.resolve(true);
      if (typeof navigator === "undefined" || !navigator.mediaDevices) {
        useMicStore.setState({ micError: "当前环境不支持麦克风" });
        return Promise.resolve(false);
      }
      return begin();
    },

    stop() {
      cancelled = true;
      const recorder = mediaRecorder;
      if (!recorder) return Promise.resolve(null);
      const durationMs = performance.now() - startedAt;
      const finished = Promise.withResolvers<Recording | null>();
      let settled = false;
      const settle = (value: Recording | null) => {
        if (settled) return;
        settled = true;
        finished.resolve(value);
      };

      // error 事件可能先于 stop 事件到达，也可能完全没有 stop：两种情况都按失败收尾。
      recorder.addEventListener("error", () => settle(null), { once: true });

      recorder.addEventListener(
        "stop",
        () => {
          const mime = recorder.mimeType || "audio/webm";
          const blob = new Blob(chunks, { type: mime });
          chunks = [];
          settle(!failed && durationMs >= MIN_RECORDING_MS && blob.size > 0 ? { blob, mime, durationMs } : null);
        },
        { once: true },
      );

      try {
        recorder.stop();
      } catch {
        settle(null);
      }
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      mediaRecorder = null;
      return finished.promise;
    },
  };
}
