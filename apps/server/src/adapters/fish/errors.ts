/**
 * Fish 适配器共用的错误类型（§3）：402 → `fish_credit`，429 → `fish_rate`，
 * 400/403/404（音色 / 权限相关）→ `fish_voice`（D49 / S6n §3）。
 * 错误对象带 `code`，交给上层现有的降级路径（TTS 无声 beat / STT 回「没听清」）。
 */

export type FishErrorCode = "fish_credit" | "fish_rate" | "fish_voice";

export class FishApiError extends Error {
  readonly code: FishErrorCode;

  constructor(code: FishErrorCode, message: string) {
    super(message);
    this.name = "FishApiError";
    this.code = code;
  }
}

export function fishErrorCodeForStatus(status: number): FishErrorCode | null {
  if (status === 402) return "fish_credit";
  if (status === 429) return "fish_rate";
  // D49 / S6n §3：4xx（非 402/429）视为音色 / 权限相关。TTS 侧据此回 voice_unavailable；
  // **不得**省略 reference_id 重试（不得静默回落默认音色）。
  if (status >= 400 && status < 500) return "fish_voice";
  return null;
}

export function isFishApiError(error: unknown): error is FishApiError {
  return error instanceof FishApiError;
}
