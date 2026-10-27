import type { ServerMessage } from "@mira/protocol";
import { createReactionSfx, installReactionSfx, reactionSfx, REACTION_SFX_URLS, type ReactionPlayback } from "./reactionSfx";
import { createAnalyserLevelSource, type AudioLevelSource } from "./audioLevel";
import { dispatchPerformance } from "./performanceClock";
import { pickNextPlayable } from "./scheduler";
import { dispatch, getStageState, pushEvent, useStageStore } from "./store";
import { timeline } from "./timeline";
import { fallbackMouth, levelToMouth, MOUTH_LEVEL_CONFIG } from "../state/mouth";

const SILENT_BEAT_MS = 1_200;

export type TtsAudioMessage = Extract<ServerMessage, { type: "tts_audio" }>;

let context: AudioContext | null = null;
let unlocked = false;
/** S5 §2：切回前台 / 首次进入时置位，下一次手势必须再 resume 一次。 */
let needsUnlock = true;
let source: AudioBufferSourceNode | null = null;
let playing: { turnId: number; seq: number } | null = null;
/** 无声 beat 的停留命令 id（D34：改由时间线驱动）。 */
let silentCommandId: number | null = null;
let analyser: AnalyserNode | null = null;
let levelSource: AudioLevelSource | null = null;
let levelRaf: number | null = null;
let mouthSmoothed = 0;
let lastLevelAt = 0;
const readyBuffers = new Map<number, AudioBuffer>();
const decoding = new Set<number>();
let observedToken = getStageState().audioStopToken;
let observedTurnId = getStageState().currentTurnId;
/** §6：本轮开始的本地时钟，用于计算上报的 clientMs（D17 在客户端测量）。 */
let turnStartedAt = nowMs();
let playbackReported = false;
let reportPlaybackStarted: ((turnId: number, seq: number, clientMs: number) => void) | null = null;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function raf(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return globalThis.setTimeout(callback, 16) as unknown as number;
}

function cancelRaf(id: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else globalThis.clearTimeout(id);
}

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

/**
 * S5 §2：iOS 音频解锁加固。
 *
 * iOS 的 AudioContext 状态不只有 `suspended`，还可能是 `interrupted`（来电、锁屏、切后台后回来），
 * 所以不能再「第一次手势后就不再管」：
 * - 每次 `pointerdown` / `keydown` / `touchend`，只要 state 不是 `running` 就再 `resume()`；
 * - `visibilitychange` 变回可见时把「需要解锁」置位，等下一次手势再解。
 */
export function installAudioUnlock(): void {
  if (typeof window === "undefined") return;

  const ensureUnlocked = (): void => {
    const audioContext = ensureContext();
    if (!audioContext) return;
    const state: string = audioContext.state;
    if (!needsUnlock && state === "running") return;
    void audioContext.resume().then(
      () => {
        needsUnlock = false;
        if (unlocked) return;
        unlocked = true;
        pushEvent("audio unlocked");
      },
      () => {
        // resume 失败（例如手势不被识别为激活）：保留 needsUnlock，等下一次手势。
      },
    );
  };

  window.addEventListener("pointerdown", ensureUnlocked, { passive: true });
  window.addEventListener("keydown", ensureUnlocked);
  window.addEventListener("touchend", ensureUnlocked, { passive: true });
  // 回到前台后必须再解一次锁（ios 的 interrupted 态）。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") needsUnlock = true;
  });
}

/** §1：接线 `source → analyser → destination`；只会创建一次 AnalyserNode。 */
function ensureAnalyser(): AnalyserNode | null {
  const audioContext = ensureContext();
  if (!audioContext || typeof AnalyserNode === "undefined") return null;
  if (!analyser) {
    const created = createAnalyserLevelSource(audioContext);
    created.node.connect(audioContext.destination);
    analyser = created.node;
    levelSource = created.source;
  }
  return analyser;
}

function dispatchMouth(shape: ReturnType<typeof fallbackMouth>, audioPlaying: boolean): void {
  dispatchPerformance({ type: "MOUTH", shape, audioPlaying });
}

function stopLevelLoop(): void {
  if (levelRaf !== null) {
    cancelRaf(levelRaf);
    levelRaf = null;
  }
}

function isCurrent(turnId: number, seq: number): boolean {
  return playing !== null && playing.turnId === turnId && playing.seq === seq;
}

/** §1：每一帧（rAF）读时域数据算 RMS → 平滑 → 口型；拿不到 AnalyserNode 时走 120ms 交替退路。 */
function startLevelLoop(turnId: number, seq: number): void {
  stopLevelLoop();
  const node = analyser;
  const level = levelSource;
  if (!node || !level || !level.available) {
    pushEvent("audio · 无 AnalyserNode，口型退回到 120ms small/open 交替");
    const startedAt = nowMs();
    const fallbackStep = (): void => {
      if (!isCurrent(turnId, seq)) return;
      dispatchMouth(fallbackMouth(nowMs() - startedAt), true);
      levelRaf = raf(fallbackStep);
    };
    levelRaf = raf(fallbackStep);
    return;
  }

  mouthSmoothed = 0;
  lastLevelAt = nowMs();
  const step = (): void => {
    if (!isCurrent(turnId, seq)) return;
    const now = nowMs();
    const dt = now - lastLevelAt;
    lastLevelAt = now;
    const { shape, smoothed } = levelToMouth(level.read(), mouthSmoothed, dt, MOUTH_LEVEL_CONFIG);
    mouthSmoothed = smoothed;
    dispatchMouth(shape, true);
    levelRaf = raf(step);
  };
  levelRaf = raf(step);
}

/** 停止音频源、清空就绪缓冲、取消无声命令、闭嘴。幂等（重复调用安全）。 */
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
  if (silentCommandId !== null) {
    timeline.cancelId(silentCommandId);
    silentCommandId = null;
  }
  playing = null;
  readyBuffers.clear();
  decoding.clear();
  stopLevelLoop();
  mouthSmoothed = 0;
  dispatchMouth("closed", false);
}

/** 打断执行器入口 ①：停止音频源（幂等）。 */
export function stopPlaybackNow(): void {
  stopPlayback();
}

/** 打断执行器入口 ②：强制口型 closed（不动时间线）。 */
export function forceMouthClosed(): void {
  stopLevelLoop();
  mouthSmoothed = 0;
  dispatchMouth("closed", false);
}

/** 打断执行器用：当前是否有音频在播放。 */
export function isAudioPlaying(): boolean {
  return playing !== null;
}

/** §5：反应音的播放句柄。 */
export type ActiveReaction = { source: AudioBufferSourceNode; gain: GainNode; stopped: boolean };
let activeReaction: ActiveReaction | null = null;
let reactionFadeSeq = 0;

/** 打断执行器用：反应音是否还在响。 */
export function isReactionActive(): boolean {
  return activeReaction !== null;
}

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
      // D34：淡出后的拆除也走时间线，不再用裸 setTimeout。
      reactionFadeSeq += 1;
      timeline.schedule({
        key: `reaction:fade:${reactionFadeSeq}`,
        turnId: getStageState().currentTurnId,
        atMs: timeline.now() + ms + 30,
        run: () => teardownReaction(reaction),
      });
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
    // D34：反应音的定时器接到统一的时间线，并带上 turnId 以便整轮取消。
    setTimer: (callback, ms, turnId) =>
      timeline.schedule({ key: `reaction:${turnId}`, turnId, atMs: timeline.now() + ms, run: callback }),
    clearTimer: (id) => timeline.cancelId(id),
    play: playReaction,
  }),
);

function schedule(): void {
  const state = getStageState();
  const next = pickNextPlayable(state, new Set(readyBuffers.keys()), playing !== null || silentCommandId !== null);
  if (!next) return;

  const turnId = state.currentTurnId;

  if (next.silent) {
    // 无声 beat 不等音频，停留 1200ms 后结束（D34：交给时间线，带 turnId）。
    dispatch({ type: "BEAT_AUDIO_STARTED", turnId, seq: next.seq });
    // §5：本轮开始出真实 beat 了，反应音淡出。
    reactionSfx()?.fadeOut();
    // §1：无声 beat 没有音频，口型保持闭合。
    dispatchMouth("closed", false);
    const seq = next.seq;
    silentCommandId = timeline.schedule({
      key: `silent:${turnId}:${seq}`,
      turnId,
      atMs: timeline.now() + SILENT_BEAT_MS,
      run: () => {
        silentCommandId = null;
        dispatch({ type: "BEAT_AUDIO_ENDED", turnId, seq });
        schedule();
      },
    });
    return;
  }

  const buffer = readyBuffers.get(next.seq);
  const audioContext = ensureContext();
  if (!buffer || !audioContext) return;
  readyBuffers.delete(next.seq);

  const nextSource = audioContext.createBufferSource();
  nextSource.buffer = buffer;
  const analyserNode = ensureAnalyser();
  if (analyserNode) nextSource.connect(analyserNode);
  else nextSource.connect(audioContext.destination);

  playing = { turnId, seq: next.seq };
  nextSource.onended = () => {
    // 已经被打断/切轮的 source 不再驱动 reducer。
    if (!playing || playing.turnId !== turnId || playing.seq !== next.seq) return;
    playing = null;
    source = null;
    stopLevelLoop();
    dispatchMouth("closed", false);
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
    reportPlaybackStarted?.(turnId, next.seq, Math.max(0, Math.round(nowMs() - turnStartedAt)));
  }
  nextSource.start();
  // §1：音量驱动的口型从这里开始。
  startLevelLoop(turnId, next.seq);
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
// 打断执行器已经做过同样的事，这里是幂等的兜底（重复 stop 不报错）。
useStageStore.subscribe((state) => {
  if (state.audioStopToken !== observedToken || state.currentTurnId !== observedTurnId) {
    observedToken = state.audioStopToken;
    observedTurnId = state.currentTurnId;
    stopPlayback();
    // §5：任何一次打断都让反应音立即停止。
    reactionSfx()?.stop();
    turnStartedAt = nowMs();
    playbackReported = false;
    pushEvent(`audio stop t${observedTurnId}`);
  }
  schedule();
});
