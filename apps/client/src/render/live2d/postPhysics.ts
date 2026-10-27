/**
 * S6m §1：物理**后覆盖**（D46③）的纯函数。
 *
 * 手（`ParamHandR/L`、`ParamHandTurnR/L`）、尾巴（`ParamTailX1–3` 等）、耳朵（`ParamEars*`）
 * 在 `yuna.physics3.json` 里是物理**输出**——在物理之前写会被覆盖。外层（`yunaRenderer.ts`）
 * 在物理 `evaluate` 之后、模型 `update` 之前按本文件给的权重混合写入：
 * `value = physicsValue * (1 - w) + clamp(target, modelMin, modelMax) * w`。
 *
 * 权重由动作的渐入 / 渐出曲线决定（0.25s 渐入、0.35s 渐出）。没有动作时（`action === null`）
 * 返回空目标 + 权重 0，不影响现有任何参数。
 *
 * 纯函数：不依赖 React / DOM / 时钟；范围截断**不在此处**（外层从 Cubism 读模型 min/max）。
 */
import { LOCAL_ACTION_DURATION_SEC, localActionSample, type LocalActionId } from "./localActions";

/** 物理后覆盖的渐入时长（秒）。 */
export const POST_FADE_IN_SEC = 0.25;
/** 物理后覆盖的渐出时长（秒）。 */
export const POST_FADE_OUT_SEC = 0.35;

/** 覆盖目标 + 权重（0 = 完全用物理值，1 = 完全用目标值）。 */
export type PostPhysicsOverride = { target: Record<string, number>; weight: number };

const EMPTY_OVERRIDE: PostPhysicsOverride = { target: {}, weight: 0 };

/**
 * 渐入 / 渐出包络权重：动作时长 `durationSec`，已进行 `elapsedSec`。
 * - 前 `POST_FADE_IN_SEC` 从 0 升到 1；
 * - 末 `POST_FADE_OUT_SEC` 从 1 降到 0；
 * - 越界 / 非有限 → 0。渐入渐出重叠时取二者较小值（长尾巴动作不会超过 1）。
 */
export function postPhysicsWeight(elapsedSec: number, durationSec: number): number {
  if (!Number.isFinite(elapsedSec) || !Number.isFinite(durationSec)) return 0;
  if (elapsedSec < 0 || elapsedSec >= durationSec) return 0;
  const fadeIn = Math.min(POST_FADE_IN_SEC, durationSec / 2);
  const fadeOut = Math.min(POST_FADE_OUT_SEC, durationSec / 2);
  const rise = fadeIn > 0 ? Math.min(1, elapsedSec / fadeIn) : 1;
  const fall = fadeOut > 0 ? Math.min(1, (durationSec - elapsedSec) / fadeOut) : 1;
  return Math.max(0, Math.min(rise, fall));
}

/**
 * `postPhysicsParams(action, elapsedSec)`：当前动作在物理之后应覆盖的参数目标与权重。
 * `action === null` → 空目标 + 权重 0（不影响现有参数）。
 */
export function postPhysicsParams(
  action: LocalActionId | null,
  elapsedSec: number,
): PostPhysicsOverride {
  if (action === null) return EMPTY_OVERRIDE;
  const weight = postPhysicsWeight(elapsedSec, LOCAL_ACTION_DURATION_SEC[action]);
  if (weight <= 0) return EMPTY_OVERRIDE;
  const { postPhysics } = localActionSample(action, elapsedSec);
  if (Object.keys(postPhysics).length === 0) return EMPTY_OVERRIDE;
  return { target: postPhysics, weight };
}
