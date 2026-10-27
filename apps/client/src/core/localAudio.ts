/**
 * S6l-fix1 §6：本地音频（兜底语音）单一音源仲裁。
 *
 * 背景：原先 `fallback.ts` 的 `playLocalAudio()` 每次新建一个 AudioContext 旁路播放，
 * 不受打断控制，于是换背景兜底 / 断线兜底与主通道的 beat 音频叠在一起。
 *
 * 现在所有本地音频都经主通道（`audio.ts` 的共享 AudioContext）播放，并由本模块仲裁：
 * - **同一时刻只有一段声音**：beat 音频开始 → 停掉正在播的本地语音；beat 播放期间来的兜底语音排队，
 *   beat 结束后再播（沿用 sceneFallback 的排队语义）；
 * - 打断（`stop`）会同时停掉本地语音并清空队列；
 * - 每当「beat 音频与本地语音同时处于播放状态」就触发一次 `onOverlap`（便于以后复查）。
 *
 * 播放/停止由外部注入，便于脱离 Web Audio 单测与属性测试。
 */

export type LocalVoicePlayback = { stop(): void };

export type LocalAudioDeps = {
  /** 真正播放一段本地语音（返回可停止的句柄；失败 / 无法播放时返回 null）。 */
  play: (url: string) => LocalVoicePlayback | null;
  /** 检测到叠加时回调（调试缓冲 pushEvent("audio_overlap")）。 */
  onOverlap?: () => void;
};

export type LocalAudioChannel = {
  /** 请求播放本地语音：正在播 beat 时排队；否则立即播放（替换上一条）。 */
  request(url: string): void;
  /** beat 音频开始：停掉正在播的本地语音，并进入「排队模式」。 */
  beatStarted(): void;
  /** beat 音频结束：若有排队的语音则播放。 */
  beatEnded(): void;
  /** 打断 / 强制停止：停掉本地语音并清空队列。 */
  stop(): void;
  /** 当前本地语音是否在播。 */
  isPlaying(): boolean;
  /** 当前是否有排队待播的语音。 */
  hasQueued(): boolean;
};

export function createLocalAudioChannel(deps: LocalAudioDeps): LocalAudioChannel {
  let active: LocalVoicePlayback | null = null;
  let queued: string | null = null;
  let beatPlaying = false;

  /** beat 与本地语音同时在播 → 记一次叠加（防御性，正常不应发生）。 */
  function reportOverlapIfBoth(): void {
    if (beatPlaying && active !== null) deps.onOverlap?.();
  }

  function start(url: string): void {
    active?.stop();
    active = deps.play(url);
    reportOverlapIfBoth();
  }

  return {
    request(url) {
      if (beatPlaying) {
        // 沿用 sceneFallback 的排队规则：beat 播放期间排队，结束后再播。
        queued = url;
        return;
      }
      start(url);
    },
    beatStarted() {
      beatPlaying = true;
      // 新的 beat 音频开始 → 停掉正在播的本地语音。
      if (active !== null) {
        active.stop();
        active = null;
      }
    },
    beatEnded() {
      beatPlaying = false;
      if (queued !== null) {
        const url = queued;
        queued = null;
        start(url);
      }
    },
    stop() {
      if (active !== null) {
        active.stop();
        active = null;
      }
      queued = null;
    },
    isPlaying() {
      return active !== null;
    },
    hasQueued() {
      return queued !== null;
    },
  };
}
