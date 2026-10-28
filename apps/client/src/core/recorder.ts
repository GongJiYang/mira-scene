import { useMicStore } from "./store";
import { rmsFromTimeDomain } from "./audioLevel";
import { isPermissionDenied } from "../live/micHints";

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4"] as const;
const MIN_RECORDING_MS = 300;

export type Recording = { blob: Blob; mime: string; durationMs: number };

/** freeze-fix8 §3：start() 失败的原因，供外壳决定显示哪条提示。 */
export type StartFailure = "denied" | "unavailable";

/** freeze-fix8 §3：start() 结果——成功，或失败 + 原因。 */
export type StartResult =
  | { started: true }
  | { started: false; reason: StartFailure };

export type Recorder = {
  /**
   * 开始录音；权限被拒绝或不可用时返回 false / 原因，并把原因写入 micError slice。
   * freeze-fix8 §3：`StartResult` 携带失败原因（`denied` = NotAllowedError，`unavailable` = 其他）。
   */
  start(): Promise<StartResult>;
  /** 停止录音；不足 300ms（误触）、没有数据或录音器出错时返回 null。 */
  stop(): Promise<Recording | null>;
  /** S6f §2：当前输入音量（RMS 0–1），未录音时返回 0。倾听声波据此跳动。 */
  level(): number;
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
  let starting: Promise<StartResult> | null = null;
  // MediaRecorder 的 error 事件：本轮录音不可用，stop() 一律返回 null。
  let failed = false;
  // stop() 早于 getUserMedia 完成时置位：避免用户松开后才开始录音。
  let cancelled = false;
  // S6f §2：录音音量（倾听声波）。AudioContext 懒建一次，stream 接入 analyser。
  let audioContext: AudioContext | null = null;
  let analyserSource: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let analyserBuffer: Float32Array<ArrayBuffer> | null = null;

  function attachAnalyser(nextStream: MediaStream): void {
    try {
      if (typeof AudioContext === "undefined") return;
      audioContext ??= new AudioContext();
      analyserSource?.disconnect();
      analyserSource = audioContext.createMediaStreamSource(nextStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyserBuffer = new Float32Array(analyser.fftSize);
      analyserSource.connect(analyser);
    } catch {
      analyser = null;
      analyserBuffer = null;
    }
  }

  function detachAnalyser(): void {
    analyserSource?.disconnect();
    analyserSource = null;
    analyser = null;
    analyserBuffer = null;
  }

  function begin(): Promise<StartResult> {
    if (starting) {
      cancelled = false;
      return starting;
    }
    cancelled = false;
    const attempt = (async (): Promise<StartResult> => {
      try {
        const nextStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          nextStream.getTracks().forEach((track) => track.stop());
          return { started: false, reason: "unavailable" };
        }
        stream = nextStream;
        attachAnalyser(nextStream);
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
        return { started: true };
      } catch (error) {
        useMicStore.setState({ micError: error instanceof Error ? error.message : "麦克风权限被拒绝" });
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        mediaRecorder = null;
        // freeze-fix8 §3：NotAllowedError（用户拒绝 / 非安全上下文）单独标记，外壳显示权限提示。
        return { started: false, reason: isPermissionDenied(error) ? "denied" : "unavailable" };
      } finally {
        starting = null;
      }
    })();
    starting = attempt;
    return attempt;
  }

  return {
    start() {
      if (mediaRecorder) return Promise.resolve<StartResult>({ started: true });
      if (typeof navigator === "undefined" || !navigator.mediaDevices) {
        useMicStore.setState({ micError: "当前环境不支持麦克风" });
        return Promise.resolve<StartResult>({ started: false, reason: "unavailable" });
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
      detachAnalyser();
      return finished.promise;
    },

    level() {
      if (!analyser || !analyserBuffer) return 0;
      analyser.getFloatTimeDomainData(analyserBuffer);
      return rmsFromTimeDomain(analyserBuffer);
    },
  };
}
