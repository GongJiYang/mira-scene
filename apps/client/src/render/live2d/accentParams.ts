/**
 * D47 / S6k §3：语境表情 accent → Live2D 参数的纯函数。
 *
 * 每个 accent 对应一个模型参数；权重曲线：
 * - beat 开始后 `ACCENT_FADE_SEC`（0.4s）线性渐入到 1；
 * - beat 结束（`untilSec` 有值）后 `ACCENT_FADE_SEC`（0.4s）线性渐出到 0。
 *
 * cry 额外叠加「流泪」（复用 `tearParams` 的 motion 曲线，以 accent 内时长采样），
 * 同样按权重缩放。`fly_head` 用 `ParamFlyHead`（**不用** `ParamFlyHead2`）。
 *
 * 纯函数：不依赖 React / DOM / 时钟。与 `yunaParams` 的合并由调用方按「取最大值」完成。
 */
import type { Accent } from "@mira/protocol";
import { tearParams } from "./yunaParams";

/** 渐入 / 渐出时长（秒）。 */
export const ACCENT_FADE_SEC = 0.4;

/**
 * accent → 主参数名。`cry` 除主参数 `ParamCry` 外还要叠加流泪（见 `accentParams`）。
 * `fly_head` 用 `ParamFlyHead`（`ParamFlyHead2` 不在此表，恒为 0）。
 */
export const ACCENT_PARAM: Record<Accent, string> = {
  love: "ParamLove",
  heart: "ParamHeart",
  shy: "ParamShy",
  amazed: "ParamAmazed",
  cry: "ParamCry",
  angry: "ParamAngry",
  black: "ParamBlack",
  dark: "ParamDark",
  fly_head: "ParamFlyHead",
  fly_pet: "ParamFlyPet",
};

/** 权重曲线：渐入 → 保持 → 渐出。`untilSec` 缺省表示 beat 尚未结束（不渐出）。 */
export function accentWeight(sinceSec: number, untilSec?: number): number {
  if (!Number.isFinite(sinceSec) || sinceSec < 0) return 0;
  if (untilSec !== undefined && Number.isFinite(untilSec) && sinceSec >= untilSec + ACCENT_FADE_SEC) return 0;
  if (sinceSec < ACCENT_FADE_SEC) return sinceSec / ACCENT_FADE_SEC;
  if (untilSec !== undefined && Number.isFinite(untilSec) && sinceSec > untilSec) {
    return Math.max(0, 1 - (sinceSec - untilSec) / ACCENT_FADE_SEC);
  }
  return 1;
}

/**
 * `accentParams(accent, sinceSec, untilSec?) → Record<string, number>`。
 * 返回该 accent 在这一时刻的参数贡献（已按权重缩放）；accent 为 null 时返回空表。
 * 权重为 0 时返回空表（不贡献任何参数）。
 */
export function accentParams(
  accent: Accent | null,
  sinceSec: number,
  untilSec?: number,
): Record<string, number> {
  if (accent === null) return {};
  const weight = accentWeight(sinceSec, untilSec);
  if (weight <= 0) return {};

  const out: Record<string, number> = { [ACCENT_PARAM[accent]]: Math.min(1, weight) };

  if (accent === "cry") {
    // 流泪曲线按 accent 内时长采样（复用 tearParams），再按权重缩放。
    for (const [name, value] of Object.entries(tearParams(sinceSec))) {
      out[name] = value * Math.min(1, weight);
    }
  }

  return out;
}

/**
 * S6l-fix2 §8：一个 accent 的时间状态。
 * - `sinceSec`：从该 accent 开始到现在的秒数；
 * - `untilSec`：该 accent「结束」时刻（相对它自己的起点，秒）；未结束则不传。
 */
export type AccentTiming = { accent: Accent; sinceSec: number; untilSec?: number };

/**
 * S6l-fix2 §8：把「正在渐出的上一个 accent」与「当前 accent」合成为一帧参数（逐键取最大值）。
 *
 * A 直接切到 B 时，若只渲染 B，A 会瞬间消失；本函数让 A 按 0.4s 渐出、B 按 0.4s 渐入，
 * 两者同时存在、取最大值。`prev` 为 null 时等价于单一 accent。
 */
export function accentBlend(prev: AccentTiming | null, current: AccentTiming | null): Record<string, number> {
  const out: Record<string, number> = {};
  const layers = [prev, current].filter((layer): layer is AccentTiming => layer !== null);
  for (const layer of layers) {
    for (const [name, value] of Object.entries(accentParams(layer.accent, layer.sinceSec, layer.untilSec))) {
      out[name] = Math.max(out[name] ?? 0, value);
    }
  }
  return out;
}
