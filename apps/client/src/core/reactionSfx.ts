/**
 * 反应音「嗯……」（§5）。
 *
 * 用户 PTT_UP / SUBMIT_TEXT 进入 thinking 后，150ms 内随机播一条短反应音：
 * - 受 `audioStopToken` 控制：任何打断都要立即停止（`stop`）。
 * - 第一个真实 beat 开始播放时淡出（`fadeOut`，80ms）。
 *
 * S6l-fix1 §5：反应音按角色（`/characters/<id>/sfx/react-*.mp3`）。URL 由 `urls()` 动态提供，
 * 每次 `arm()` 时按当前角色取值；某角色没有反应音时返回空数组 → 不播（不回退到全局文件）。
 *
 * 逻辑与音频实现分离：真实的播放/淡出由 audio.ts 注入，这里只做「什么时候播、什么时候停」，
 * 因此可以脱离 DOM 单测。
 */

/** 进入 thinking 后最迟这么多毫秒内播放（§5：150ms 内）。 */
export const REACTION_ARM_DELAY_MS = 150;
/** 淡出时长（§5）。 */
export const REACTION_FADE_MS = 80;

export type ReactionPlayback = {
  /** 用 ms 时长把音量降到 0 后停止。 */
  fadeOut(ms: number): void;
  /** 立即停止。 */
  stop(): void;
};

export type ReactionDeps = {
  /** S6l-fix1 §5：按当前角色动态取反应音 URL（返回空数组表示该角色没有反应音 → 不播）。 */
  urls: () => readonly string[];
  random: () => number;
  /** 定时器由外壳注入（D34：接到统一的时间线，带 turnId 以便整轮取消）。 */
  setTimer: (callback: () => void, ms: number, turnId: number) => number;
  clearTimer: (id: number) => void;
  play: (url: string) => ReactionPlayback | null;
};

export type ReactionSfx = {
  arm(turnId: number): void;
  stop(): void;
  fadeOut(): void;
};

export function createReactionSfx(deps: ReactionDeps): ReactionSfx {
  let timer: number | null = null;
  let active: ReactionPlayback | null = null;
  let armedTurnId: number | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  }

  function stopActive(): void {
    if (active) {
      active.stop();
      active = null;
    }
  }

  return {
    arm(turnId) {
      const urls = deps.urls();
      if (urls.length === 0) return;
      clearTimer();
      stopActive();
      armedTurnId = turnId;
      timer = deps.setTimer(
        () => {
          timer = null;
          if (armedTurnId !== turnId) return;
          const index = Math.min(Math.floor(deps.random() * urls.length), urls.length - 1);
          const url = urls[index] ?? urls[0];
          if (url === undefined) return;
          active = deps.play(url);
        },
        REACTION_ARM_DELAY_MS,
        turnId,
      );
    },

    stop() {
      armedTurnId = null;
      clearTimer();
      stopActive();
    },

    fadeOut() {
      armedTurnId = null;
      clearTimer();
      if (active) {
        active.fadeOut(REACTION_FADE_MS);
        active = null;
      }
    },
  };
}

let installed: ReactionSfx | null = null;

/** 由 audio.ts 在模块加载时装配（注入真实的 Web Audio 播放实现）。 */
export function installReactionSfx(sfx: ReactionSfx): void {
  installed = sfx;
}

export function reactionSfx(): ReactionSfx | null {
  return installed;
}
