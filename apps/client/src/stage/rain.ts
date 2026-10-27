/**
 * 雨参数（架构关卡 §3：必须是纯函数，写单测）。
 *
 * `rainParams(fx, tMs) → { count, speed, alpha }`
 * - `fx` 是持续状态（取 visual.fx 的最新值）。
 * - `tMs` 是**当前 fx 状态已经持续的毫秒数**（外壳在 fx 变化时把 tMs 归零）。
 * - `reducedMotion` 为 true 时雨量减半（§3，`prefers-reduced-motion`）。
 *
 * 强度：rain_heavy 恒为 1；rain_stop 在 4s 内线性降到 0；warm_glow 为 0（已雨停）；
 * lights_dim 保持下雨；fx 为 null（尚未收到任何 beat）按会话开始的暴雨处理。
 */
import type { Fx } from "@mira/protocol";

export const RAIN_STOP_FADE_MS = 4_000;
export const BASE_RAIN_COUNT = 160;
export const BASE_RAIN_SPEED = 1;
export const BASE_RAIN_ALPHA = 0.4;
export const REDUCED_MOTION_COUNT_RATIO = 0.5;

export type RainParams = { count: number; speed: number; alpha: number };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function rainIntensity(fx: Fx | null, tMs: number): number {
  switch (fx) {
    case "rain_stop":
      return clamp01(1 - tMs / RAIN_STOP_FADE_MS);
    case "warm_glow":
      return 0;
    case "rain_heavy":
    case "lights_dim":
      return 1;
    default:
      return 1;
  }
}

export function rainParams(fx: Fx | null, tMs: number, reducedMotion = false): RainParams {
  const intensity = rainIntensity(fx, tMs);
  const count = Math.round(BASE_RAIN_COUNT * intensity * (reducedMotion ? REDUCED_MOTION_COUNT_RATIO : 1));
  return { count, speed: BASE_RAIN_SPEED, alpha: BASE_RAIN_ALPHA * intensity };
}
