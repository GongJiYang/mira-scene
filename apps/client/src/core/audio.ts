import type { ServerMessage } from "@mira/protocol";
import { pickNextPlayable } from "./scheduler";
import { dispatch, getStageState, pushEvent, useStageStore } from "./store";

const SILENT_BEAT_MS = 1_200;

export type TtsAudioMessage = Extract<ServerMessage, { type: "tts_audio" }>;

let context: AudioContext | null = null;
let unlocked = false;
let source: AudioBufferSourceNode | null = null;
let playing: { turnId: number; seq: number } | null = null;
let silentTimer: number | null = null;
const readyBuffers = new Map<number, AudioBuffer>();
const decoding = new Set<number>();
let observedToken = getStageState().audioStopToken;
let observedTurnId = getStageState().currentTurnId;

function ensureContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  context ??= new AudioContext();
  return context;
}

/** 第一次用户手势时 resume()，用于解锁 iOS AudioContext。 */
export function installAudioUnlock(): void {
  if (typeof window === "undefined") return;
  const unlock = () => {
    void ensureContext()
      ?.resume()
      .then(() => {
        if (unlocked) return;
        unlocked = true;
        window.removeEventListener("pointerdown", unlock);
        window.removeEventListener("keydown", unlock);
        pushEvent("audio unlocked");
      });
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

function stopPlayback(): void {
  if (source) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // 已结束的 source 调用 stop() 会抛错，忽略。
    }
    source.disconnect();
    source = null;
  }
  if (silentTimer) {
    window.clearTimeout(silentTimer);
    silentTimer = null;
  }
  playing = null;
  readyBuffers.clear();
  decoding.clear();
}

function schedule(): void {
  const state = getStageState();
  const next = pickNextPlayable(state, new Set(readyBuffers.keys()), playing !== null || silentTimer !== null);
  if (!next) return;

  const turnId = state.currentTurnId;

  if (next.silent) {
    // 无声 beat 不等音频，停留 1200ms 后结束。
    dispatch({ type: "BEAT_AUDIO_STARTED", turnId, seq: next.seq });
    silentTimer = window.setTimeout(() => {
      silentTimer = null;
      dispatch({ type: "BEAT_AUDIO_ENDED", turnId, seq: next.seq });
      schedule();
    }, SILENT_BEAT_MS);
    return;
  }

  const buffer = readyBuffers.get(next.seq);
  const audioContext = ensureContext();
  if (!buffer || !audioContext) return;
  readyBuffers.delete(next.seq);

  const nextSource = audioContext.createBufferSource();
  nextSource.buffer = buffer;
  nextSource.connect(audioContext.destination);
  playing = { turnId, seq: next.seq };
  nextSource.onended = () => {
    // 已经被打断/切轮的 source 不再驱动 reducer。
    if (!playing || playing.turnId !== turnId || playing.seq !== next.seq) return;
    playing = null;
    source = null;
    dispatch({ type: "BEAT_AUDIO_ENDED", turnId, seq: next.seq });
    schedule();
  };
  source = nextSource;

  // 指令（字幕/视觉/media）绑定在该 beat 音频开始的时刻。
  dispatch({ type: "BEAT_AUDIO_STARTED", turnId, seq: next.seq });
  nextSource.start();
}

export function handleTtsAudio(message: TtsAudioMessage): void {
  const state = getStageState();
  if (message.turnId !== state.currentTurnId) return;

  const seq = message.payload.beatSeq;
  if (readyBuffers.has(seq) || decoding.has(seq)) return;

  const audioContext = ensureContext();
  if (!audioContext) return;

  const { turnId } = message;
  const token = state.audioStopToken;
  decoding.add(seq);

  let decodeBuffer: ArrayBuffer;
  try {
    const bytes = Uint8Array.from(atob(message.payload.dataBase64), (char) => char.charCodeAt(0));
    decodeBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(decodeBuffer).set(bytes);
  } catch {
    decoding.delete(seq);
    console.warn("[audio] base64 解码失败，丢弃该 tts_audio");
    return;
  }

  audioContext.decodeAudioData(decodeBuffer).then(
    (buffer) => {
      decoding.delete(seq);
      const latest = getStageState();
      // decodeAudioData 是异步的：期间可能已经切轮或被打断，必须再检查一次。
      if (latest.currentTurnId !== turnId || latest.audioStopToken !== token) return;
      readyBuffers.set(seq, buffer);
      pushEvent(`audio ready t${turnId}#${seq}`);
      schedule();
    },
    (error: unknown) => {
      decoding.delete(seq);
      console.warn("[audio] 解码失败，丢弃该 tts_audio", error);
    },
  );
}

// audioStopToken 或 currentTurnId 变化 → 立即停止并清空就绪缓冲；其余变化也重新调度。
useStageStore.subscribe((state) => {
  if (state.audioStopToken !== observedToken || state.currentTurnId !== observedTurnId) {
    observedToken = state.audioStopToken;
    observedTurnId = state.currentTurnId;
    stopPlayback();
    pushEvent(`audio stop t${observedTurnId}`);
  }
  schedule();
});
