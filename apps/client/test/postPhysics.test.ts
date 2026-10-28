import { describe, expect, it } from "vitest";
import {
  POST_FADE_IN_SEC,
  POST_FADE_OUT_SEC,
  postPhysicsParams,
  postPhysicsWeight,
} from "../src/render/live2d/postPhysics";
import { LOCAL_ACTION_DURATION_SEC } from "../src/render/live2d/localActions";

describe("S6m §1：postPhysicsWeight 渐入 / 渐出", () => {
  it("端点权重为 0，中间为 1", () => {
    const dur = 2;
    expect(postPhysicsWeight(0, dur)).toBe(0);
    expect(postPhysicsWeight(dur, dur)).toBe(0);
    expect(postPhysicsWeight(dur / 2, dur)).toBe(1);
  });

  it("前 0.25s 渐入、后 0.35s 渐出", () => {
    const dur = 2;
    expect(postPhysicsWeight(POST_FADE_IN_SEC / 2, dur)).toBeCloseTo(0.5);
    expect(postPhysicsWeight(POST_FADE_IN_SEC, dur)).toBe(1);
    // 渐出：距结束 POST_FADE_OUT_SEC 处为 1，距结束一半处约 0.5。
    expect(postPhysicsWeight(dur - POST_FADE_OUT_SEC, dur)).toBe(1);
    expect(postPhysicsWeight(dur - POST_FADE_OUT_SEC / 2, dur)).toBeCloseTo(0.5);
    expect(postPhysicsWeight(dur - 1e-6, dur)).toBeLessThan(0.001);
  });

  it("越界 / 非有限 → 0", () => {
    expect(postPhysicsWeight(-1, 2)).toBe(0);
    expect(postPhysicsWeight(3, 2)).toBe(0);
    expect(postPhysicsWeight(Number.NaN, 2)).toBe(0);
    expect(postPhysicsWeight(1, Number.NaN)).toBe(0);
  });
});

describe("S6m §1：postPhysicsParams 不影响现有参数（无动作时）", () => {
  it("action=null → 空目标 + 权重 0", () => {
    const out = postPhysicsParams(null, 1);
    expect(out.target).toEqual({});
    expect(out.weight).toBe(0);
  });

  it("越界时间 → 空目标", () => {
    expect(postPhysicsParams("tail_wag", -1).target).toEqual({});
    expect(postPhysicsParams("tail_wag", 10).weight).toBe(0);
  });
});

describe("S6m §1/§2：混合公式 value = phys*(1-w) + target*w", () => {
  const mix = (phys: number, target: number, w: number): number => phys * (1 - w) + target * w;

  it("w=0 保持物理值；w=1 取目标；w=0.5 取中值", () => {
    expect(mix(0.5, 1, 0)).toBeCloseTo(0.5);
    expect(mix(0.5, 1, 1)).toBeCloseTo(1);
    expect(mix(0.5, 1, 0.5)).toBeCloseTo(0.75);
  });

  it("tail_wag 中途权重为 1，目标带 ParamTailX 参数", () => {
    const out = postPhysicsParams("tail_wag", LOCAL_ACTION_DURATION_SEC.tail_wag / 2);
    expect(out.weight).toBe(1);
    expect(out.target.ParamTailX1).toBeDefined();
  });
});
