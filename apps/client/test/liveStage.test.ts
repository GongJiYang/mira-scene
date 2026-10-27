import { describe, expect, it } from "vitest";
import {
  fitModel,
  LIVE_FIT_PRESETS,
  LIVE_MOBILE_MAX_WIDTH,
  livePresetFor,
  MODEL_BOUNDS,
} from "../src/render/live2d/cubism/fit";
import { toYunaEmotion } from "../src/live/emotionMap";

/**
 * S6b §3：忧奈接入正式舞台的构图与映射（纯函数部分）。
 * 用户 2026-10-27 确认：桌面人物高约 80%、中心在 56% 高处；手机高约 62%、中心在 66% 高处。
 */

const BOUNDS_H = MODEL_BOUNDS.top - MODEL_BOUNDS.bottom;

describe("直播间构图预设（S6b §3）", () => {
  it("桌面：人物高约画面 80%，中心在 56% 高处", () => {
    const preset = LIVE_FIT_PRESETS.liveDesktop;
    expect(preset.heightRatio).toBeCloseTo(0.8, 5);
    // 中心在 56% 高处 → 相对画布中心向上 6%。
    expect(preset.offsetYRatio).toBeCloseTo(0.06, 5);
    expect(preset.offsetXRatio).toBe(0);
  });

  it("手机：人物高约画面 62%，中心在 66% 高处", () => {
    const preset = LIVE_FIT_PRESETS.liveMobile;
    expect(preset.heightRatio).toBeCloseTo(0.62, 5);
    expect(preset.offsetYRatio).toBeCloseTo(0.16, 5);
    expect(preset.offsetXRatio).toBe(0);
  });

  it("按 900px 断点选预设（与 §4 的布局断点一致）", () => {
    expect(LIVE_MOBILE_MAX_WIDTH).toBe(900);
    expect(livePresetFor(390)).toBe("liveMobile");
    expect(livePresetFor(899)).toBe("liveMobile");
    expect(livePresetFor(900)).toBe("liveDesktop");
    expect(livePresetFor(1440)).toBe("liveDesktop");
  });

  it("桌面画布：人物高度确实约为画布 80%（宽度放得下时）", () => {
    const width = 1440;
    const height = 900;
    const fit = fitModel(width, height, MODEL_BOUNDS, LIVE_FIT_PRESETS.liveDesktop);
    // 归一化画布高 2.0；人物可见高度 = boundsH * scale。
    const subjectHeight = BOUNDS_H * fit.scale;
    expect(subjectHeight / 2.0).toBeCloseTo(0.8, 2);
  });

  it("手机画布：人物高度约为画布 62%", () => {
    const width = 390;
    const height = 844;
    const fit = fitModel(width, height, MODEL_BOUNDS, LIVE_FIT_PRESETS.liveMobile);
    const subjectHeight = BOUNDS_H * fit.scale;
    expect(subjectHeight / 2.0).toBeCloseTo(0.62, 2);
  });

  it("人物中心落在预设的垂直位置（56% / 66% 高处）", () => {
    for (const [preset, expectedCenter] of [
      [LIVE_FIT_PRESETS.liveDesktop, 0.56],
      [LIVE_FIT_PRESETS.liveMobile, 0.66],
    ] as const) {
      const width = 1000;
      const height = 1000;
      const fit = fitModel(width, height, MODEL_BOUNDS, preset);
      const boundsCenterY = (MODEL_BOUNDS.bottom + MODEL_BOUNDS.top) / 2;
      // 归一化画布：中心在原点、高 2.0。屏幕 y 向上为正，
      // 「56% 高处」= 相对中心 +6% 画布高 = +0.06 * 2.0 = +0.12。
      const centerInCanvas = boundsCenterY * fit.scale + fit.y;
      expect(centerInCanvas).toBeCloseTo((expectedCenter - 0.5) * 2.0, 5);
    }
  });

  it("水平居中（offsetXRatio = 0 时人物中心在画布中线）", () => {
    const fit = fitModel(1440, 900, MODEL_BOUNDS, LIVE_FIT_PRESETS.liveDesktop);
    const boundsCenterX = (MODEL_BOUNDS.left + MODEL_BOUNDS.right) / 2;
    expect(boundsCenterX * fit.scale + fit.x).toBeCloseTo(0, 6);
  });

  it("人物不超出画布上下边界", () => {
    for (const preset of [LIVE_FIT_PRESETS.liveDesktop, LIVE_FIT_PRESETS.liveMobile]) {
      const fit = fitModel(1440, 900, MODEL_BOUNDS, preset);
      const top = MODEL_BOUNDS.top * fit.scale + fit.y;
      const bottom = MODEL_BOUNDS.bottom * fit.scale + fit.y;
      expect(top).toBeLessThanOrEqual(1.0 + 1e-9);
      expect(bottom).toBeGreaterThanOrEqual(-1.0 - 1e-9);
    }
  });
});

describe("情绪映射（S6b §3）", () => {
  it("模型支持的四种情绪原样透传", () => {
    expect(toYunaEmotion("calm")).toBe("calm");
    expect(toYunaEmotion("guarded")).toBe("guarded");
    expect(toYunaEmotion("sad")).toBe("sad");
    expect(toYunaEmotion("warm")).toBe("warm");
    expect(toYunaEmotion("neutral")).toBe("neutral");
  });

  it("surprised 没有对应参数组合 → 用 calm 兜底（S6a §1.3 只做四情绪）", () => {
    expect(toYunaEmotion("surprised")).toBe("calm");
  });
});
