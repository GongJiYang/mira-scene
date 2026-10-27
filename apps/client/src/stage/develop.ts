/**
 * 拍立得显影进度（架构关卡 §3：必须是纯函数，写单测）。
 *
 * `developProgress(elapsedMs) → 0..1`：图像透明度在 3s 内从 0 升到 1（§6）。
 */

export const DEVELOP_MS = 3_000;

export function developProgress(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return elapsedMs >= DEVELOP_MS ? 1 : elapsedMs / DEVELOP_MS;
}
