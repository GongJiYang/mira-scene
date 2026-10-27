import { describe, expect, it } from "vitest";
import {
  VIEW_LIMITS,
  clampView,
  live2dParams,
  type ViewLook,
  type Live2dParamInput,
} from "../src/render/live2d/params";

describe("clampView：产品上限是唯一出处", () => {
  it("范围内的值原样通过", () => {
    const look: ViewLook = { eyeX: 0.3, eyeY: -0.2, headX: 12, headY: -8, headZ: 5 };
    expect(clampView(look)).toEqual(look);
  });

  it("超出上限的一律截断（含正负两侧）", () => {
    const clamped = clampView({ eyeX: 1, eyeY: -1, headX: 30, headY: -30, headZ: 20 });
    expect(clamped).toEqual({
      eyeX: VIEW_LIMITS.gazeX,
      eyeY: -VIEW_LIMITS.gazeY,
      headX: VIEW_LIMITS.headDeg,
      headY: -VIEW_LIMITS.headDeg,
      headZ: VIEW_LIMITS.headDeg,
    });
  });
});

describe("live2dParams：B 的一帧 → 参数", () => {
  const base: Live2dParamInput = { phase: "idle", blink: "open", mouth: "closed" };

  it("倾听看镜头：视线与头部都是 0，嘴闭合", () => {
    const p = live2dParams({ ...base, phase: "listening", mouth: "open" });
    expect(p.ParamEyeBallX).toBe(0);
    expect(p.ParamEyeBallY).toBe(0);
    expect(p.ParamAngleX).toBe(0);
    // speaking 之外的 phase，口型由 B 保证是 closed；这里仍按传入值映射
    expect(p.ParamMouthOpenY).toBe(1);
  });

  it("思考：视线偏开但不超过 0.3 左右；转头不超过上限", () => {
    const p = live2dParams({ ...base, phase: "thinking" });
    expect(Math.abs(p.ParamEyeBallX)).toBeLessThanOrEqual(VIEW_LIMITS.gazeX);
    expect(Math.abs(p.ParamEyeBallY)).toBeLessThanOrEqual(VIEW_LIMITS.gazeY);
    expect(p.ParamEyeBallX).not.toBe(0);
    expect(Math.abs(p.ParamAngleX)).toBeLessThanOrEqual(VIEW_LIMITS.headDeg);
  });

  it("闭眼 / 半眼 / 口型三档映射正确", () => {
    expect(live2dParams({ ...base, blink: "closed" }).ParamEyeLOpen).toBe(0);
    expect(live2dParams({ ...base, blink: "half" }).ParamEyeROpen).toBe(0.5);
    expect(live2dParams({ ...base, mouth: "small" }).ParamMouthOpenY).toBe(0.5);
    expect(live2dParams({ ...base, mouth: "open" }).ParamMouthOpenY).toBe(1);
  });

  it("调用方传进来的极限视线也被截断（无法绕过上限）", () => {
    const p = live2dParams({
      ...base,
      look: { eyeX: 1, eyeY: 1, headX: 30, headY: -30, headZ: 0 },
    });
    expect(p.ParamEyeBallX).toBe(VIEW_LIMITS.gazeX);
    expect(p.ParamEyeBallY).toBe(VIEW_LIMITS.gazeY);
    expect(p.ParamAngleX).toBe(VIEW_LIMITS.headDeg);
    expect(p.ParamAngleY).toBe(-VIEW_LIMITS.headDeg);
  });
});
