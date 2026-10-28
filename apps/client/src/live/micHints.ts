/**
 * freeze-fix8 §2/§3：麦克风提示的两个纯函数（关卡 3：函数式核心）。
 *
 * 只做判定，不碰 DOM / React，便于单测：
 * - 短按判定：按下到松开 < 300ms → 显示「按住说话」轻提示。
 * - 可用性判定：非安全上下文或没有 getUserMedia → 麦克风不可用。
 */

/** freezefix8 §2：与 `recorder.ts` 的 MIN_RECORDING_MS 一致——短于此时长录音被丢弃。 */
export const SHORT_PRESS_MS = 300;

/**
 * freeze-fix8 §2：一次「按住说话」是短按吗（会被 recorder 当误触丢弃）？
 * 非有限 / 负时长按非短按处理（返回 false）。
 */
export function isShortPress(heldMs: number): boolean {
  return Number.isFinite(heldMs) && heldMs >= 0 && heldMs < SHORT_PRESS_MS;
}

/** freeze-fix8 §3：判定麦克风是否可用所需的环境信息。 */
export type MicEnv = {
  /** `window.isSecureContext`（HTTPS 或 localhost 才为 true）。 */
  isSecureContext: boolean;
  /** `navigator.mediaDevices?.getUserMedia` 是否存在。 */
  hasGetUserMedia: boolean;
};

/** freeze-fix8 §3：麦克风不可用的原因。 */
export type MicUnavailableReason = "insecure" | "unsupported";

/**
 * freeze-fix8 §3：麦克风是否可用（纯函数）。
 * 只有同时满足「安全上下文」与「有 getUserMedia」才可用。
 * 不可用时返回原因：非安全上下文 → `insecure`；否则 → `unsupported`。
 */
export function micAvailability(env: MicEnv): { available: true } | { available: false; reason: MicUnavailableReason } {
  if (!env.isSecureContext) return { available: false, reason: "insecure" };
  if (!env.hasGetUserMedia) return { available: false, reason: "unsupported" };
  return { available: true };
}

/**
 * freeze-fix8 §3：读取当前浏览器环境（外壳，非纯函数）。
 * 返回 `null` 表示「不是真实浏览器」（SSR / 测试环境没有 `window`）——
 * 此时不做预判，交给 recorder 的 `start()` 决定（保持既有行为）。
 * 浏览器里则按 `isSecureContext` + `getUserMedia` 如实上报：`http://<IP>` 下 mediaDevices 为 undefined。
 */
export function readMicEnv(): MicEnv | null {
  if (typeof window === "undefined") return null;
  return {
    isSecureContext: window.isSecureContext === true,
    hasGetUserMedia: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
  };
}

/**
 * freeze-fix8 §3：是否应因环境不可用而拦截这次按下（纯函数）。
 * `env === null`（非真实浏览器）→ false：不拦截，走 recorder。
 */
export function blocksMic(env: MicEnv | null): boolean {
  if (env === null) return false;
  return !micAvailability(env).available;
}

/** freeze-fix8 §3：录音权限被拒（NotAllowedError）的判定（纯函数）。 */
export function isPermissionDenied(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "NotAllowedError" : false;
}
