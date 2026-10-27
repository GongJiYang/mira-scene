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
  /**
   * 真正播放一段本地语音（返回可停止的句柄；失败 / 无法播放时返回 null）。
   * S6l-fix2 §9：`onEnded` 在语音自然播完后调用，用于清空 `active`（避免 `isPlaying()` 一直为 true）。
   */
  play: (url: string, onEnded?: () => void) => LocalVoicePlayback | null;
  /** 检测到叠加时回调（调试缓冲 pushEvent("audio_overlap")）。 */
  onOverlap?: () => void;
};

export type LocalAudioChannel = {
  /** 请求播放本地语音：本轮播放中（beat 之间也算）则排队；否则立即播放（替换上一条）。 */
  request(url: string): void;
  /** beat 音频开始：停掉正在播的本地语音，并进入「本轮进行中」。 */
  beatStarted(): void;
  /** beat 音频结束：只标记 beat 暂停，**不**播放排队语音（S6l-fix2 §9）。 */
  beatEnded(): void;
  /** 本轮结束、回到 idle / listening：这时才播放排队的本地语音（S6l-fix2 §9）。 */
  turnEnded(): void;
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
  /** S6l-fix2 §9：本轮是否有 beat 序列在进行（从 beatStarted 到 turnEnded / stop）。 */
  let turnActive = false;

  /** beat 与本地语音同时在播 → 记一次叠加（防御性，正常不应发生）。 */
  function reportOverlapIfBoth(): void {
    if (beatPlaying && active !== null) deps.onOverlap?.();
  }

  function start(url: string): void {
    active?.stop();
    // S6l-fix2 §9：句柄播完回调 → 清空 active（否则 isPlaying() 一直为 true）。
    // 用局部变量记录本次句柄，播完回调只清自己（避免清掉后被替换的新句柄）。
    let handle: LocalVoicePlayback | null = null;
    handle = deps.play(url, () => {
      if (active === handle) active = null;
    });
    active = handle;
    reportOverlapIfBoth();
  }

  return {
    request(url) {
      if (beatPlaying || turnActive) {
        // S6l-fix2 §9：本轮还没结束（含 beat 之间的空档）→ 排队，等本轮结束（turnEnded）再播。
        queued = url;
        return;
      }
      start(url);
    },
    beatStarted() {
      beatPlaying = true;
      turnActive = true;
      // 新的 beat 音频开始 → 停掉正在播的本地语音。
      if (active !== null) {
        active.stop();
        active = null;
      }
    },
    beatEnded() {
      // S6l-fix2 §9：beat 结束只标记；排队语音等本轮结束（turnEnded）再播，避免被下一句掐断。
      beatPlaying = false;
    },
    turnEnded() {
      // S6l-fix2 §9：本轮结束、回到 idle / listening → 播放排队的本地语音。
      beatPlaying = false;
      turnActive = false;
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
      beatPlaying = false;
      turnActive = false;
    },
    isPlaying() {
      return active !== null;
    },
    hasQueued() {
      return queued !== null;
    },
  };
}
