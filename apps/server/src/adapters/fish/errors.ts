/**
 * Fish 适配器共用的错误类型（§3）：402 → `fish_credit`，429 → `fish_rate`。
 * 错误对象带 `code`，交给上层现有的降级路径（TTS 无声 beat / STT 回「没听清」）。
 */

export type FishErrorCode = "fish_credit" | "fish_rate";

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
  return null;
}

export function isFishApiError(error: unknown): error is FishApiError {
  return error instanceof FishApiError;
}
