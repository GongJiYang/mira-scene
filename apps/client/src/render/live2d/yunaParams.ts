/**
 * 忧奈（漠）Live2D 参数纯函数（S6a §1.3）。
 *
 * 与 `params.ts` 的夏凛映射不同：忧奈模型没有 `ParamBreath`，四情绪也没有现成 exp3，
 * 全部靠参数组合表达（REPORT §5.2）。`params.ts` 依然是视线 / 转头的唯一出处，
 * 本文件的 `ParamEyeBall*` / `ParamAngle*` **必经** `live2dParams()` 与 `clampView()`，
 * 不许在别处直接写这些参数（D36）。
 *
 * 纯函数：不依赖 React、不依赖 DOM、不读时钟。呼吸由调用方传入的 `tSec` 驱动。
 */
import { clampView, MOUTH_OPEN, VIEW_BY_PHASE, type ViewLook } from "./params";
import type { MouthShape, StagePhaseKind } from "../../state/performance";

export { MOUTH_OPEN };

/** S6a §1.3：四种情绪；`neutral` 视同 `calm`（模型默认脸）。 */
export type YunaEmotion = "calm" | "guarded" | "sad" | "warm" | "neutral";

export type YunaParamInput = {
  phase: StagePhaseKind;
  emotion: YunaEmotion;
  mouth: MouthShape;
  /** 眨眼开合值 0–1（来自 CubismEyeBlink）；最终再经 `EYE_OPEN_MAX` 上限。 */
  blinkOpen: number;
  /** 可选：额外视线（如 beat 朝向）；仍会经 `clampView()`。 */
  look?: ViewLook;
  /** 秒；驱动正弦呼吸。 */
  tSec: number;
};

/* ------------------------------------------------------------------------------------------------
 * 常量表（§1.3：数值集中放这里，便于后续调）。
 * 正负方向以预览实测为准，实测结论写进 `s6a-report.md`。
 * ---------------------------------------------------------------------------------------------- */

/**
 * 情绪参数组合。键为模型参数名；`neutral` 视同 `calm`（不叠加）。
 *
 * 正负方向已在预览页实测核对（2026-10-27，截图见 e2e/out/emotion-*.png）：
 * - guarded：眼睛开合上限压到 0.6（见 `EMOTION_EYE_MAX`）、眉压低 → 一脸「防备」。
 * - sad：`ParamBrowLAngle=-1`/`ParamBrowRAngle=+1` 得到**内高外低的八字眉**，
 *   配合眉压低与 `ParamMouthForm=-1` 的嘴角下撇、眼睛上限 0.55 → 重睑下垂 + 撇嘴。
 * - warm：`ParamMouthForm=+0.7` 嘴角上扬、笑眼、`ParamShy=1` 脸红。
 *
 * 注意：`ParamEyeLOpen/ROpen` **不**放在本表里 —— 它们由 `EMOTION_EYE_MAX` 表达为
 * 「上限」，在 `applyEyeOpen` 里与自动眨眼值相乘/取小，避免情绪覆盖掉眨眼（S6a-fix1 §2）。
 */
export type EmotionParams = Record<string, number>;

export const EMOTION_PARAMS: Record<YunaEmotion, EmotionParams> = {
  // calm：不叠加（模型默认脸）。
  calm: {},
  neutral: {},
  // guarded：眉压低（眼睛上限见 EMOTION_EYE_MAX）。
  guarded: {
    ParamBrowLY: -0.4,
    ParamBrowRY: -0.4,
  },
  // sad：八字眉（内高外低 → 用 ±Angle 表达）、眉压低、嘴角下撇。
  // S6a-fix1 §5：加大与 calm 的区分度（原值 -0.3 / -0.6 与 calm 肉眼难辨）。
  sad: {
    ParamBrowLAngle: -1,
    ParamBrowRAngle: 1,
    ParamBrowLY: -0.8,
    ParamBrowRY: -0.8,
    ParamMouthForm: -1,
  },
  // warm：嘴角上扬、笑眼、脸红。
  warm: {
    ParamMouthForm: 0.7,
    ParamEyeLSmile: 0.6,
    ParamEyeRSmile: 0.6,
    ParamShy: 1,
  },
};

/**
 * 情绪对眼睛开合（`ParamEyeLOpen/ROpen`）的**上限**，单位与 `ParamEyeLOpen` 一致（直接截断值）。
 * 未列出的情绪不限（= `EYE_OPEN_MAX`）。guarded 压到 0.6（沿用 S6a 原值）、
 * sad 压到 0.55（S6a-fix1 §5：该模型眉毛被刘海遮住、`ParamMouthForm` 视觉影响极小，
 * 眼睛开合是唯一肉眼可见的「悲伤」杠杆，故用它把 sad 与 calm 拉开）。
 */
export const EMOTION_EYE_MAX: Partial<Record<YunaEmotion, number>> = {
  guarded: 0.6,
  sad: 0.55,
};

/** guarded 时眼睛开合的上限（§1.3，兼容旧导出）。 */
export const GUARDED_EYE_MAX = EMOTION_EYE_MAX.guarded as number;

/**
 * 睁眼把 `blinkOpen`（0–1 的归一化开合）映射到的 `ParamEyeLOpen` 上限。
 * 模型的 `ParamEyeLOpen` 舒适区间是 [0, 1.9]（REPORT §4），默认脸即半眯；
 * 取 1.9 让 blinkOpen=1 时眼睛真正睁开（实测预览：1 会一直半眯）。
 */
export const EYE_OPEN_MAX = 1.9;

/**
 * 所有情绪用到的参数名并集（S6a-fix1 §1）。输出始终包含这些键，
 * 当前情绪没用到的键给 0，避免外壳不重置参数导致切情绪后旧值残留。
 */
export const EMOTION_KEYS: readonly string[] = Array.from(
  new Set(Object.values(EMOTION_PARAMS).flatMap((params) => Object.keys(params))),
);

/** 呼吸：用 `ParamBodyAngleY` / `ParamAngleY` 的正弦表达（模型没有 `ParamBreath`）。 */
export const BREATH_PERIOD_SEC = 3.5;
export const BREATH_BODY_AMPLITUDE = 2;
export const BREATH_HEAD_AMPLITUDE = 1.5;
/** speaking 时呼吸幅度减半（§1.3）。 */
export const BREATH_SPEAKING_SCALE = 0.5;

/** 视线 X 取反（VTube Studio 里 `ParamEyeBallX` 是反向映射，REPORT §4）。 */
export const GAZE_X_INVERTED = true;

/* ------------------------------------------------------------------------------------------------
 * 后置条件（§1.3）：输出参数一律落在舒适区间内。
 * 区间取自 REPORT §4 的 VTube Studio 输出范围。
 * ---------------------------------------------------------------------------------------------- */

export const COMFORT_RANGES: Record<string, readonly [number, number]> = {
  ParamAngleX: [-30, 30],
  ParamAngleY: [-30, 30],
  ParamAngleZ: [-30, 30],
  ParamBodyAngleX: [-10, 10],
  ParamBodyAngleY: [-10, 10],
  ParamBodyAngleZ: [-10, 10],
  ParamEyeBallX: [-1, 1],
  ParamEyeBallY: [-1, 1],
  ParamEyeLOpen: [0, 1.9],
  ParamEyeROpen: [0, 1.9],
  ParamMouthOpenY: [0, 2.1],
  ParamMouthForm: [-1, 1],
};

/** 其余参数（眉、笑眼、脸红等）的默认区间。 */
export const DEFAULT_RANGE: readonly [number, number] = [-1, 1];

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

/** 把单个参数截断到舒适区间（未知参数用 `DEFAULT_RANGE`）。 */
export function clampParam(name: string, value: number): number {
  const range = COMFORT_RANGES[name] ?? DEFAULT_RANGE;
  return clamp(value, range[0], range[1]);
}

/**
 * `approach(current, target, dt)`：逐帧向目标逼近的纯函数（§1.3 情绪插值用）。
 * `dt` ∈ [0,1] 是本帧逼近的比例；0 保持、1 直达。非有限值按 0 处理。
 */
export function approach(current: number, target: number, dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return current;
  if (dt >= 1) return target;
  return current + (target - current) * dt;
}

/**
 * `combineBlink(auto, manual)`：把框架 `CubismEyeBlink` 的自动开合值与手动眨眼值相乘
 * （S6a-fix1 §2）。两个输入都先在 [0,1] 截断；任一方为 0（闭眼）结果即为 0。
 *
 * 外壳在 EyeBlink 写完之后读出它写的值作为 `auto`，再乘手动值，最后交给 `applyEyeOpen`，
 * 这样自动眨眼不会被预览页里常量 1 的手动值覆盖。
 */
export function combineBlink(auto: number, manual: number): number {
  return clamp(auto, 0, 1) * clamp(manual, 0, 1);
}

/**
 * `approachParams(current, target, dt)`：对 target 的每个键逐键调用 `approach`（S6a-fix1 §3）。
 * 键集合以 target 为准（current 里多出来的键不保留）。dt ∈ [0,1] 是本帧逼近比例。
 */
export function approachParams(
  current: Record<string, number>,
  target: Record<string, number>,
  dt: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(target)) {
    const from = current[name];
    out[name] = approach(from === undefined ? value : from, value, dt);
  }
  return out;
}

/**
 * `applyEyeOpen(blinkOpen, emotion)`：把 `CubismEyeBlink` 产出的开合值（0–1）转成
 * 模型的 `ParamEyeLOpen/ROpen` —— 先按 `EYE_OPEN_MAX` 放大，再按情绪上限截断
 * （guarded → 0.6、sad → 0.8，见 `EMOTION_EYE_MAX`）。
 *
 * §1.3 要求「眨眼开合值最终要经过上限」，框架的 EyeBlink 每帧写 0–1，所以外壳在它之后
 * 调这个纯函数把最终值落回舒适区间，决策仍集中在纯函数里。
 */
export function applyEyeOpen(blinkOpen: number, emotion: YunaEmotion): number {
  const open = clamp(blinkOpen, 0, 1) * EYE_OPEN_MAX;
  const max = EMOTION_EYE_MAX[emotion] ?? EYE_OPEN_MAX;
  return clampParam("ParamEyeLOpen", Math.min(open, max));
}

/** 正弦呼吸偏移；speaking 幅度减半。返回 body / head 两个正负一致的偏移量。 */
export function breathOffsets(tSec: number, speaking: boolean): { bodyY: number; headY: number } {
  const scale = speaking ? BREATH_SPEAKING_SCALE : 1;
  const wave = Math.sin((2 * Math.PI * tSec) / BREATH_PERIOD_SEC);
  return {
    bodyY: wave * BREATH_BODY_AMPLITUDE * scale,
    headY: wave * BREATH_HEAD_AMPLITUDE * scale,
  };
}

/**
 * 忧奈的一帧 → Live2D 参数值（§1.3）。
 *
 * 后置条件：返回值里每个参数都在 `COMFORT_RANGES` / `DEFAULT_RANGE` 内，无 NaN，
 * 且**始终包含 `EMOTION_KEYS` 的全部键**（当前情绪没用到的给 0，S6a-fix1 §1）。
 * 视线与转头经 `clampView()`（`params.ts` 的 `live2dParams` 是唯一出处）。
 */
export function yunaParams(input: YunaParamInput): Record<string, number> {
  const speaking = input.phase === "speaking";

  // 视线与转头：先经 params.ts 的 clampView（唯一出处）拿到截断后的目标视线。
  const look = clampView(input.look ?? VIEW_BY_PHASE[input.phase]);

  const breath = breathOffsets(input.tSec, speaking);

  // 呼吸叠加在头部 Y 上；再经一次参数级截断，保证仍在舒适区内。
  const headY = clampParam("ParamAngleY", look.headY + breath.headY);

  // 眨眼开合：0–1 经 `applyEyeOpen`（放大到模型范围 + 情绪上限）。
  const eyeOpen = applyEyeOpen(input.blinkOpen, input.emotion);

  const out: Record<string, number> = {
    // 视线 X 取反（VTube 反向映射）。
    ParamEyeBallX: (GAZE_X_INVERTED ? -1 : 1) * look.eyeX,
    ParamEyeBallY: look.eyeY,
    ParamAngleX: look.headX,
    ParamAngleY: headY,
    ParamAngleZ: look.headZ,
    ParamBodyAngleX: 0,
    ParamBodyAngleY: breath.bodyY,
    ParamBodyAngleZ: 0,
    ParamEyeLOpen: eyeOpen,
    ParamEyeROpen: eyeOpen,
    ParamMouthOpenY: MOUTH_OPEN[input.mouth],
    ParamMouthForm: 0,
  };

  // §1（残留）：先给所有情绪键铺 0，再用当前情绪覆盖，保证输出键集合恒定。
  for (const name of EMOTION_KEYS) out[name] = 0;
  // 情绪叠加（calm / neutral 为空表）；眼睛开合由 applyEyeOpen 处理，不被覆盖。
  for (const [name, value] of Object.entries(EMOTION_PARAMS[input.emotion])) {
    out[name] = value;
  }

  // 后置条件：最后统一截断到舒适区间。
  for (const name of Object.keys(out)) {
    out[name] = clampParam(name, out[name] as number);
  }
  return out;
}
