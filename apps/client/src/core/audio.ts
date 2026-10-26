import type { ServerMessage } from "@mira/protocol";
import { createReactionSfx, installReactionSfx, reactionSfx, REACTION_SFX_URLS, type ReactionPlayback } from "./reactionSfx";
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
/** §6：本轮开始的本地时钟，用于计算上报的 clientMs（D17 在客户端测量）。 */
let turnStartedAt = performance.now();
let playbackReported = false;
let reportPlaybackStarted: ((turnId: number, seq: number, clientMs: number) => void) | null = null;

/** §6：由 connection 注入，把「第一个 beat 开始播放」上报给服务端。 */
export function setPlaybackStartedReporter(
  reporter: (turnId: number, seq: number, clientMs: number) => void,
): void {
  reportPlaybackStarted = reporter;
}

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

/** §5：反应音的播放句柄。 */
export type ActiveReaction = { source: AudioBufferSourceNode; gain: GainNode; stopped: boolean };
let activeReaction: ActiveReaction | null = null;

function teardownReaction(reaction: ActiveReaction | null): void {
  if (!reaction || reaction.stopped) return;
  reaction.stopped = true;
  reaction.source.onended = null;
  try {
    reaction.source.stop();
  } catch {
    // 已结束的 source 调用 stop() 会抛错，忽略。
  }
  reaction.source.disconnect();
  reaction.gain.disconnect();
  if (activeReaction === reaction) activeReaction = null;
}

/** §5：真实的反应音播放（fetch → decode → 播放），返回可淡出/立即停止的句柄。 */
function playReaction(url: string): ReactionPlayback | null {
  const audioContext = ensureContext();
  if (!audioContext) return null;
  teardownReaction(activeReaction);

  const gain = audioContext.createGain();
  gain.connect(audioContext.destination);
  const state = { cancelled: false, reaction: null as ActiveReaction | null };

  const handle: ReactionPlayback = {
    fadeOut(ms) {
      const reaction = state.reaction;
      if (!reaction || reaction.stopped) {
        state.cancelled = true;
        return;
      }
      const now = audioContext.currentTime;
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + ms / 1000);
      window.setTimeout(() => teardownReaction(reaction), ms + 30);
    },
    stop() {
      state.cancelled = true;
      teardownReaction(state.reaction);
    },
  };

  void fetch(url)
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(`反应音 ${response.status}`))))
    .then((buffer) => audioContext.decodeAudioData(buffer))
    .then((decoded) => {
      if (state.cancelled) {
        gain.disconnect();
        return;
      }
      const nextSource = audioContext.createBufferSource();
      nextSource.buffer = decoded;
      nextSource.connect(gain);
      const reaction: ActiveReaction = { source: nextSource, gain, stopped: false };
      state.reaction = reaction;
      activeReaction = reaction;
      nextSource.onended = () => {
        if (activeReaction === reaction) {
          activeReaction = null;
          gain.disconnect();
        }
      };
      nextSource.start();
    })
    .catch(() => {
      gain.disconnect();
    });

  return handle;
}

installReactionSfx(
  createReactionSfx({
    urls: REACTION_SFX_URLS,
    random: Math.random,
    setTimer: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
    clearTimer: (id) => globalThis.clearTimeout(id),
    play: playReaction,
  }),
);

function schedule(): void {
  const state = getStageState();
  const next = pickNextPlayable(state, new Set(readyBuffers.keys()), playing !== null || silentTimer !== null);
  if (!next) return;

  const turnId = state.currentTurnId;

  if (next.silent) {
    // 无声 beat 不等音频，停留 1200ms 后结束。
    dispatch({ type: "BEAT_AUDIO_STARTED", turnId, seq: next.seq });
    // §5：本轮开始出真实 beat 了，反应音淡出。
    reactionSfx()?.fadeOut();
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
  // §5：第一个真实 beat 开始播放 → 反应音淡出（80ms）。
  reactionSfx()?.fadeOut();
  // §6：第一个 beat 的音频开始播放 → 上报 playback_started。
  if (!playbackReported) {
    playbackReported = true;
    reportPlaybackStarted?.(turnId, next.seq, Math.max(0, Math.round(performance.now() - turnStartedAt)));
  }
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
    // §5：任何一次打断都让反应音立即停止。
    reactionSfx()?.stop();
    turnStartedAt = performance.now();
    playbackReported = false;
    pushEvent(`audio stop t${observedTurnId}`);
  }
  schedule();
});
