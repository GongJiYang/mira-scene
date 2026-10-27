/**
 * 忧奈（漠）Live2D 参数纯函数（S6a §1.3；S6f §2 四态扩展）。
 *
 * 与 `params.ts` 的夏凛映射不同：忧奈模型没有 `ParamBreath`，四情绪也没有现成 exp3，
 * 全部靠参数组合表达（REPORT §5.2）。`params.ts` 依然是视线 / 转头的唯一出处，
 * 本文件的 `ParamEyeBall*` / `ParamAngle*` **必经** `live2dParams()` 与 `clampView()`，
 * 不许在别处直接写这些参数（D36）。
 *
 * 纯函数：不依赖 React、不依赖 DOM、不读时钟。呼吸由调用方传入的 `tSec` 驱动；
 * 待机小动作的随机数由调用方传入 `seed`（纯函数可测）。
 *
 * S6f §2：四态（待机 / 倾听 / 思考 / 说话）在人物上必须可分辨——
 * 倾听有身体前倾 + 头微歪 + 每 2–3s 点头；思考头歪向另一侧、眨眼变慢；
 * 说话叠加哭哭 / 流泪 / 首句惊讶；待机有随机小动作（抱熊 / 瞟向一侧 / 耳朵轻动）。
 */
import { clampView, MOUTH_OPEN, VIEW_BY_PHASE, type ViewLook } from "./params";
import type { Action } from "@mira/protocol";
import type { MouthShape, StagePhaseKind } from "../../state/performance";

export { MOUTH_OPEN };

/** S6a §1.3：四种情绪；`neutral` 视同 `calm`（模型默认脸）。 */
export type YunaEmotion = "calm" | "guarded" | "sad" | "warm" | "neutral";

/** S6f §2：`content.json` 的无声动作（`drink / phone / show_item / glance`）。 */
export type SilentAction = Action;

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
  /** S6f §2：进入当前 phase 的秒数（倾听点头 / 思考慢眨眼 / 300ms 过渡用）。 */
  phaseSinceSec?: number;
  /** S6f §2：待机持续的秒数（>8s 后每 8–14s 触发生成一个随机小动作）。 */
  idleSinceSec?: number;
  /** S6f §2：本会话第一句回话开始以来的秒数（首句叠加惊讶 1.2s；未开始传 undefined）。 */
  firstSpokeSinceSec?: number;
  /** S6f §2：当前无声动作（来自 content.json 的 look.silentAction / beat.suggest）。 */
  silentAction?: SilentAction | null;
  /** S6f §2：待机小动作的种子（0–1，调用方每 8–14s 换一个新的）；纯函数可测。 */
  seed?: number;
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
 * S6f §2：四态动作常量表（参数名均以 `漠.cdi3.json` 为准）。
 * ---------------------------------------------------------------------------------------------- */

/** 倾听：身体前倾（ParamBodyAngleY）+ 头微歪（ParamAngleZ ≈ 6°）+ 每 2–3s 一次点头。 */
export const LISTEN_BODY_FORWARD = 6;
export const LISTEN_HEAD_TILT_Z = 6;
export const LISTEN_NOD_PERIOD_SEC = 2.5; // 落在 2–3s 区间
export const LISTEN_NOD_AMPLITUDE = 3; // ParamAngleY 下上幅度（度）
export const LISTEN_NOD_WIDTH_SEC = 0.4; // 一次点头持续时长（秒）
/** 倾听过渡：进入倾听 300ms 内从上一姿态到位。 */
export const LISTEN_TRANSITION_SEC = 0.3;

/** 思考：头歪向另一侧（与倾听反向）、眨眼变慢（眼开合上限压低）。 */
export const THINK_HEAD_TILT_Z = -5;
export const THINK_EYE_MAX = 1.3;
export const THINK_TRANSITION_SEC = 0.3;

/** 待机小动作（idleSinceSec > 8 后每 8–14s 随机一个，由 seed 决定哪一种）。 */
export const IDLE_ACTION_MIN_GAP_SEC = 8;
export const IDLE_ACTION_WINDOW_SEC = 6; // 8 + 0..6 → 8–14s
export const IDLE_PET_SEC = 4; // 抱熊持续 3–5s，取 4
export const IDLE_GLANCE_SEC = 1.5; // 瞟向一侧 1.5s
export const IDLE_EAR_SEC = 2; // 耳朵轻动 2s
export const IDLE_EAR_AMPLITUDE = 0.4;

/** 说话首句叠加惊讶的持续秒数（S6f §2）。 */
export const SPEAK_AMAZED_SEC = 1.2;

/**
 * S6f §2：`silentAction` 在忧奈身上的映射。
 * - `drink` → 低头 + 闭眼 1 秒；
 * - `phone` → 视线向下 2 秒；
 * - `show_item` → 抱熊 3 秒；
 * - `glance` → 看向一侧 1.5 秒。
 */
export const SILENT_ACTION_TABLE: Record<SilentAction, { durationSec: number; params: Record<string, number> }> = {
  drink: { durationSec: 1, params: { ParamAngleY: 8, ParamEyeLOpen: 0, ParamEyeROpen: 0 } },
  phone: { durationSec: 2, params: { ParamEyeBallY: -0.25 } },
  show_item: { durationSec: 3, params: { ParamPet: 1 } },
  glance: { durationSec: 1.5, params: { ParamEyeBallX: 0.3, ParamAngleX: -4 } },
};

/**
 * S6f §2 禁止参数：任何输入下都必须为 0。
 * 飞头 / 飞宠 / 脸黑 / 黑眼圈 / 生气 + 水印授权文字 Param1–Param10。
 */
export const FORBIDDEN_KEYS: readonly string[] = [
  "ParamFlyHead",
  "ParamFlyHead2",
  "ParamFlyPet",
  "ParamBlack",
  "ParamDark",
  "ParamAngry",
  ...Array.from({ length: 10 }, (_, i) => `Param${i + 1}`),
];

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
 * （guarded → 0.6、sad → 0.55，见 `EMOTION_EYE_MAX`）。
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

/* ------------------------------------------------------------------------------------------------
 * S6f §2：四态辅助纯函数。
 * ---------------------------------------------------------------------------------------------- */

/** 倾听的点头偏移（ParamAngleY 下上）。单峰：先下后上，峰值在 `LISTEN_NOD_WIDTH_SEC / 2`。 */
export function listenNodOffset(phaseSinceSec: number): number {
  if (phaseSinceSec < 0) return 0;
  const t = phaseSinceSec % LISTEN_NOD_PERIOD_SEC;
  if (t > LISTEN_NOD_WIDTH_SEC) return 0;
  const half = LISTEN_NOD_WIDTH_SEC / 2;
  const phase = t < half ? t / half : (LISTEN_NOD_WIDTH_SEC - t) / half;
  return LISTEN_NOD_AMPLITUDE * phase;
}

/** 待机小动作：由 idleSinceSec + seed 推出当前应叠加的参数（无动作时返回空表）。 */
export function idleActionParams(idleSinceSec: number, seed: number, tSec: number): Record<string, number> {
  // S6f §2：严格大于 8s 才开始（idleSinceSec = 8 时仍无小动作）。
  if (idleSinceSec <= IDLE_ACTION_MIN_GAP_SEC) return {};
  const s = clamp(seed, 0, 1);
  // 8–14s 一个窗口；窗口内的相对秒数决定小动作是否激活。
  const windowOffset =
    (idleSinceSec - IDLE_ACTION_MIN_GAP_SEC) % (IDLE_ACTION_WINDOW_SEC + Math.max(IDLE_PET_SEC, IDLE_EAR_SEC));
  const kind = Math.floor(s * 3); // 0=抱熊 1=瞟向一侧 2=耳朵轻动
  if (kind === 0) {
    return windowOffset < IDLE_PET_SEC ? { ParamPet: 1 } : {};
  }
  if (kind === 1) {
    return windowOffset < IDLE_GLANCE_SEC ? { ParamEyeBallX: 0.3, ParamAngleX: -4 } : {};
  }
  if (windowOffset < IDLE_EAR_SEC) {
    const wave = Math.sin((2 * Math.PI * tSec) / 0.8);
    return { ParamEarsLX1: IDLE_EAR_AMPLITUDE * wave, ParamEarsRX1: IDLE_EAR_AMPLITUDE * wave };
  }
  return {};
}

/**
 * 流泪 motion 的纯函数采样（S6f §2：不依赖 SDK 表情管理器）。
 * 曲线形状按 REPORT §3.2 的实测要点还原为分段线性，周期 5.2s 循环：
 * - `ParamTearLY`（左泪下流）：t≈0.58 起 0→1（t≈2.17），2.44 过冲到 2，再于 2.6 归零；
 * - `ParamTearRY` 在 t≈2.9 起同样过程（左右错开约 2.3s）；
 * - `ParamTearL/R`（酝酿）在各自下流段前升到 1、下流结束后回落；
 * - `ParamTearAppearL/R`（出现）在对应下流段内为 1，其余为 0。
 * 返回 6 个泪参数的值（未激活的给 0）。
 */
export function tearParams(tSec: number): Record<string, number> {
  const DURATION = 5.2;
  const t = ((tSec % DURATION) + DURATION) % DURATION;

  // 单段：start 起 0→1（riseEnd 达到），hold 到 peakAt 过冲到 overshoot，再于 endAt 归零。
  const segment = (start: number, riseEnd: number, peakAt: number, overshoot: number, endAt: number): number => {
    if (t < start || t >= endAt) return 0;
    if (t < riseEnd) return (t - start) / (riseEnd - start);
    if (t < peakAt) return 1 + ((overshoot - 1) * (t - riseEnd)) / (peakAt - riseEnd);
    return overshoot * (1 - (t - peakAt) / (endAt - peakAt));
  };

  const tearLY = segment(0.58, 2.17, 2.44, 2, 2.6);
  const tearRY = segment(2.9, 4.5, 4.77, 2, 4.93);
  const tearL = t < 0.58 ? t / 0.58 : t < 2.6 ? 1 : 0;
  const tearR = t >= 2.3 && t < 2.9 ? (t - 2.3) / 0.6 : t >= 2.9 && t < 4.93 ? 1 : 0;

  return {
    ParamTearL: clamp(tearL, 0, 1),
    ParamTearAppearL: tearLY > 0.02 ? 1 : 0,
    ParamTearLY: clamp(tearLY, 0, 2),
    ParamTearR: clamp(tearR, 0, 1),
    ParamTearAppearR: tearRY > 0.02 ? 1 : 0,
    ParamTearRY: clamp(tearRY, 0, 2),
  };
}

/** 说话首句的惊讶叠加：firstSpokeSinceSec ∈ [0, SPEAK_AMAZED_SEC) 时为 1，其余为 0。 */
export function speakAmazed(firstSpokeSinceSec: number | undefined): number {
  if (firstSpokeSinceSec === undefined) return 0;
  return firstSpokeSinceSec >= 0 && firstSpokeSinceSec < SPEAK_AMAZED_SEC ? 1 : 0;
}

/* ------------------------------------------------------------------------------------------------
 * 忧奈的一帧 → Live2D 参数值（§1.3 + S6f §2）。
 *
 * 后置条件：返回值里每个参数都在 `COMFORT_RANGES` / `DEFAULT_RANGE` 内，无 NaN；
 * 始终包含 `EMOTION_KEYS` 与 `FORBIDDEN_KEYS` 的全部键（禁止参数恒为 0）；
 * 视线与转头经 `clampView()`（`params.ts` 的 `live2dParams` 是唯一出处）。
 * ---------------------------------------------------------------------------------------------- */
export function yunaParams(input: YunaParamInput): Record<string, number> {
  const speaking = input.phase === "speaking";
  const phaseSince = input.phaseSinceSec ?? 0;

  // 视线与转头：先经 params.ts 的 clampView（唯一出处）拿到截断后的目标视线。
  const look = clampView(input.look ?? VIEW_BY_PHASE[input.phase]);

  const breath = breathOffsets(input.tSec, speaking);

  // 呼吸叠加在头部 Y 上；再经一次参数级截断，保证仍在舒适区内。
  let headY = clampParam("ParamAngleY", look.headY + breath.headY);
  let headZ = look.headZ;
  let bodyY = breath.bodyY;
  let eyeOpenMax: number | undefined;

  // S6f §2：phase 姿态（倾听前倾 + 头歪 + 点头；思考反向头歪 + 慢眨眼）。300ms 过渡。
  if (input.phase === "listening") {
    const w = Math.min(1, phaseSince / LISTEN_TRANSITION_SEC);
    bodyY = clampParam("ParamBodyAngleY", bodyY + LISTEN_BODY_FORWARD * w);
    headZ = clampParam("ParamAngleZ", headZ + LISTEN_HEAD_TILT_Z * w);
    headY = clampParam("ParamAngleY", headY + listenNodOffset(phaseSince));
    // 倾听眼睛开到最大：不压上限。
  } else if (input.phase === "thinking") {
    const w = Math.min(1, phaseSince / THINK_TRANSITION_SEC);
    headZ = clampParam("ParamAngleZ", headZ + THINK_HEAD_TILT_Z * w);
    eyeOpenMax = THINK_EYE_MAX;
  }

  // 眨眼开合：0–1 经 `applyEyeOpen`（放大到模型范围 + 情绪上限）。
  let eyeOpen = applyEyeOpen(input.blinkOpen, input.emotion);
  if (eyeOpenMax !== undefined) eyeOpen = Math.min(eyeOpen, eyeOpenMax);

  const out: Record<string, number> = {
    // 视线 X 取反（VTube 反向映射）。
    ParamEyeBallX: (GAZE_X_INVERTED ? -1 : 1) * look.eyeX,
    ParamEyeBallY: look.eyeY,
    ParamAngleX: look.headX,
    ParamAngleY: headY,
    ParamAngleZ: headZ,
    ParamBodyAngleX: 0,
    ParamBodyAngleY: bodyY,
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

  // S6f §2：禁止参数与水印参数恒为 0（任何输入下）。
  for (const name of FORBIDDEN_KEYS) out[name] = 0;

  // S6f §2：待机小动作（抱熊 / 瞟向一侧 / 耳朵轻动；由 idleSinceSec + seed 决定）。
  if (input.phase === "idle") {
    for (const [name, value] of Object.entries(idleActionParams(input.idleSinceSec ?? 0, input.seed ?? 0, input.tSec))) {
      out[name] = (out[name] ?? 0) + value;
    }
  }

  // S6f §2：silentAction 映射（覆盖对应参数：drink 的低头+闭眼、phone 的视线向下等）。
  if (input.silentAction) {
    const entry = SILENT_ACTION_TABLE[input.silentAction];
    for (const [name, value] of Object.entries(entry.params)) {
      out[name] = value;
    }
  }

  // S6f §2：说话首句叠加惊讶（1.2s；只在本会话第一句回话开始时）。
  out.ParamAmazed = speakAmazed(input.firstSpokeSinceSec);

  // S6f §2：sad → 哭哭（ParamCry）+ 流泪（泪参数按 motion3 曲线纯函数采样）。
  if (input.emotion === "sad") {
    out.ParamCry = 1;
    for (const [name, value] of Object.entries(tearParams(input.tSec))) {
      out[name] = value;
    }
  } else {
    out.ParamCry = 0;
    out.ParamTearL = 0;
    out.ParamTearAppearL = 0;
    out.ParamTearLY = 0;
    out.ParamTearR = 0;
    out.ParamTearAppearR = 0;
    out.ParamTearRY = 0;
  }

  // 保证键集合恒定（惊讶与抱熊未激活时也出现）。
  out.ParamPet = out.ParamPet ?? 0;
  out.ParamEarsLX1 = out.ParamEarsLX1 ?? 0;
  out.ParamEarsRX1 = out.ParamEarsRX1 ?? 0;

  // 后置条件：最后统一截断到舒适区间。
  for (const name of Object.keys(out)) {
    out[name] = clampParam(name, out[name] as number);
  }
  return out;
}
