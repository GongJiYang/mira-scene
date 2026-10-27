import { describe, expect, it } from "vitest";
import type { Accent } from "@mira/protocol";
import {
  ACCENT_FADE_SEC,
  ACCENT_PARAM,
  accentParams,
  accentWeight,
} from "../src/render/live2d/accentParams";

const ACCENTS: Accent[] = [
  "love",
  "heart",
  "shy",
  "amazed",
  "cry",
  "angry",
  "black",
  "dark",
  "fly_head",
  "fly_pet",
];

describe("accentWeight：0.4s 渐入 / 渐出曲线", () => {
  it("渐入：0 → 1（0.4s 内线性）", () => {
    expect(accentWeight(0)).toBe(0);
    expect(accentWeight(ACCENT_FADE_SEC / 2)).toBeCloseTo(0.5);
    expect(accentWeight(ACCENT_FADE_SEC)).toBe(1);
    expect(accentWeight(10)).toBe(1);
  });

  it("渐出：beat 结束后 0.4s 内线性到 0", () => {
    const until = 2;
    expect(accentWeight(until, until)).toBe(1);
    expect(accentWeight(until + ACCENT_FADE_SEC / 2, until)).toBeCloseTo(0.5);
    expect(accentWeight(until + ACCENT_FADE_SEC, until)).toBe(0);
    expect(accentWeight(until + ACCENT_FADE_SEC + 1, until)).toBe(0);
  });

  it("untilSec 越长保持段越长（保持 1）", () => {
    expect(accentWeight(5, 10)).toBe(1);
  });

  it("非法输入归 0", () => {
    expect(accentWeight(Number.NaN)).toBe(0);
    expect(accentWeight(-1)).toBe(0);
  });
});

describe("accentParams：映射与键集合", () => {
  it("accent=null → 空表", () => {
    expect(accentParams(null, 1)).toEqual({});
  });

  it("fly_head 用 ParamFlyHead（不用 ParamFlyHead2）", () => {
    expect(ACCENT_PARAM.fly_head).toBe("ParamFlyHead");
    const out = accentParams("fly_head", ACCENT_FADE_SEC);
    expect(out.ParamFlyHead).toBe(1);
    expect(out.ParamFlyHead2).toBeUndefined();
  });

  it("每个 accent 在稳态下恰好写自己的主参数 = 1（cry 附加泪参数）", () => {
    for (const accent of ACCENTS) {
      const out = accentParams(accent, ACCENT_FADE_SEC);
      expect(out[ACCENT_PARAM[accent]]).toBeCloseTo(1);
    }
  });

  it("cry 叠加流泪参数（复用 tearParams，按权重缩放）", () => {
    const out = accentParams("cry", 1);
    expect(out.ParamCry).toBe(1);
    // t=1 时左泪已在下流（tearParams(1).ParamTearLY > 0）。
    expect(out.ParamTearLY).toBeGreaterThan(0);
  });

  it("渐入瞬间权重 0 → 不贡献任何参数", () => {
    expect(accentParams("love", 0)).toEqual({});
  });

  it("渐入中间参数按权重缩放", () => {
    expect(accentParams("love", ACCENT_FADE_SEC / 2).ParamLove).toBeCloseTo(0.5);
  });
});
