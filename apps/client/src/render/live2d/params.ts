/**
 * 状态机 B → Live2D 参数的纯映射（D28 + D36）。
 *
 * 验收导出测的是 EyeBall=±1、AngleX=±30 这种极限姿态，但产品里的 B 根本用不到那么大：
 * 倾听看镜头（偏移 0）、思考视线偏开（约 0.3）、转头不超过 ±15°。极限姿态下才出现的破绽
 * 在实际演出里不会出现，所以这里把上限做成**唯一出处** —— Live2D 运行时必须经由
 * `live2dParams()` 产出参数，不要在别处直接写 ParamEyeBall* / ParamAngle*。
 *
 * 纯函数：不依赖 React、不依赖 DOM，与 `view/useStageViewModel.ts` 的 `toStageView` 同类。
 */
import type { Blink, MouthShape, StagePhaseKind } from "../../state/performance";

/** 产品侧上限（①）。超出部分一律截断，不做平滑，保证任何输入都落在这个范围内。 */
export const VIEW_LIMITS = { gazeX: 0.35, gazeY: 0.25, headDeg: 15 } as const;

/** 一次演出里 B 能表达的视线 / 头部偏移。角度单位是度，视线是 -1..1 的归一化值。 */
export type ViewLook = { eyeX: number; eyeY: number; headX: number; headY: number; headZ: number };

/** 按 D28 的表演映射表给出各 phase 的目标视线；speaking 跟随 beat，这里保持看镜头。 */
export const VIEW_BY_PHASE: Record<StagePhaseKind, ViewLook> = {
  idle: { eyeX: 0, eyeY: 0, headX: 0, headY: 0, headZ: 0 },
  listening: { eyeX: 0, eyeY: 0, headX: 0, headY: 0, headZ: 0 },
  thinking: { eyeX: -0.3, eyeY: -0.15, headX: -4, headY: -3, headZ: 0 },
  speaking: { eyeX: 0, eyeY: 0, headX: 0, headY: 0, headZ: 0 },
  error: { eyeX: 0, eyeY: 0, headX: 0, headY: 0, headZ: 0 },
};

function clampAxis(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

/** 把任意视线截断到产品上限内。 */
export function clampView(look: ViewLook): ViewLook {
  return {
    eyeX: clampAxis(look.eyeX, VIEW_LIMITS.gazeX),
    eyeY: clampAxis(look.eyeY, VIEW_LIMITS.gazeY),
    headX: clampAxis(look.headX, VIEW_LIMITS.headDeg),
    headY: clampAxis(look.headY, VIEW_LIMITS.headDeg),
    headZ: clampAxis(look.headZ, VIEW_LIMITS.headDeg),
  };
}

const EYE_OPEN: Record<Blink, { l: number; r: number }> = {
  open: { l: 1, r: 1 },
  half: { l: 0.5, r: 0.5 },
  closed: { l: 0, r: 0 },
};

/** 口型三档 → `ParamMouthOpenY`（`params.ts` 是 Live2D 参数映射的唯一出处，S6a-fix1 §4）。 */
export const MOUTH_OPEN: Record<MouthShape, number> = { closed: 0, small: 0.5, open: 1 };

export type Live2dParamInput = {
  phase: StagePhaseKind;
  blink: Blink;
  mouth: MouthShape;
  /** 可选：这一帧的视线（例如 idle 的缓慢漂移、beat 自带的朝向）。默认取 `VIEW_BY_PHASE[phase]`。 */
  look?: ViewLook;
};

/** 一帧产出的参数值；只含 psd2live 导出的标准参数（ParamEye* / ParamAngle* / ParamMouth*）。 */
export type Live2dParams = {
  ParamEyeBallX: number;
  ParamEyeBallY: number;
  ParamAngleX: number;
  ParamAngleY: number;
  ParamAngleZ: number;
  ParamEyeLOpen: number;
  ParamEyeROpen: number;
  ParamMouthOpenY: number;
};

/** B 的一帧 → Live2D 参数值。上限在最后统一施加，调用方不可能绕过。 */
export function live2dParams(input: Live2dParamInput): Live2dParams {
  const look = clampView(input.look ?? VIEW_BY_PHASE[input.phase]);
  const eye = EYE_OPEN[input.blink];
  return {
    ParamEyeBallX: look.eyeX,
    ParamEyeBallY: look.eyeY,
    ParamAngleX: look.headX,
    ParamAngleY: look.headY,
    ParamAngleZ: look.headZ,
    ParamEyeLOpen: eye.l,
    ParamEyeROpen: eye.r,
    ParamMouthOpenY: MOUTH_OPEN[input.mouth],
  };
}
