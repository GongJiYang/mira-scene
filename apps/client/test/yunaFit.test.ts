import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FIT_PRESETS,
  fitModel,
  LIVE_FIT_PRESETS,
  MOBILE_MAX_WIDTH,
  MODEL_BOUNDS,
  modelBBoxTopPx,
  presetFor,
  type ModelBounds,
} from "../src/render/live2d/cubism/fit";

/** 把模型坐标点经 `fitModel` 结果映射到归一化画布空间（画布中心为原点、高 2.0）。 */
function mapPoint(p: { x: number; y: number }, fit: { scale: number; x: number; y: number }): { x: number; y: number } {
  return { x: p.x * fit.scale + fit.x, y: p.y * fit.scale + fit.y };
}

describe("presetFor：按画布宽度选预设（S6a-fix2 §3）", () => {
  it("窄于阈值用 mobile，否则 desktop", () => {
    expect(presetFor(MOBILE_MAX_WIDTH - 1)).toBe("mobile");
    expect(presetFor(MOBILE_MAX_WIDTH)).toBe("desktop");
    expect(presetFor(1440)).toBe("desktop");
    expect(presetFor(390)).toBe("mobile");
  });
});

describe("fitModel：把模型可见包围盒装进画布（S6a-fix2 §3）", () => {
  it("人物高度约占画布高度 92%，且水平居中", () => {
    const fit = fitModel(1440, 900, MODEL_BOUNDS, FIT_PRESETS.desktop);
    const boundsH = MODEL_BOUNDS.top - MODEL_BOUNDS.bottom;
    // 归一化画布高 = 2.0，可见区域高应为 0.92 * 2。
    expect(fit.scale * boundsH).toBeCloseTo(0.92 * 2, 6);

    // 可见区域中心映射后落回画布中心（偏移 0）。
    const centerPoint = mapPoint(
      { x: (MODEL_BOUNDS.left + MODEL_BOUNDS.right) / 2, y: (MODEL_BOUNDS.bottom + MODEL_BOUNDS.top) / 2 },
      fit,
    );
    expect(centerPoint.x).toBeCloseTo(0, 6);
    expect(centerPoint.y).toBeCloseTo(0, 6);
  });

  it("四个角都落在归一化画布内（不出画）", () => {
    const fit = fitModel(1440, 900, MODEL_BOUNDS, FIT_PRESETS.desktop);
    const normCanvasW = (1440 / 900) * 2;
    const corners = [
      { x: MODEL_BOUNDS.left, y: MODEL_BOUNDS.bottom },
      { x: MODEL_BOUNDS.right, y: MODEL_BOUNDS.bottom },
      { x: MODEL_BOUNDS.left, y: MODEL_BOUNDS.top },
      { x: MODEL_BOUNDS.right, y: MODEL_BOUNDS.top },
    ];
    for (const c of corners) {
      const mapped = mapPoint(c, fit);
      expect(Math.abs(mapped.x)).toBeLessThanOrEqual(normCanvasW / 2 + 1e-9);
      expect(Math.abs(mapped.y)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("窄画布（宽度受限）时按宽度收紧，仍不出画", () => {
    // 极高的窄画布：高度优先会超宽，此时应被宽度收紧。
    const w = 200;
    const h = 2000;
    const fit = fitModel(w, h, MODEL_BOUNDS, FIT_PRESETS.mobile);
    const normCanvasW = (w / h) * 2;
    const boundsW = MODEL_BOUNDS.right - MODEL_BOUNDS.left;
    expect(fit.scale * boundsW).toBeLessThanOrEqual(normCanvasW + 1e-9);
  });

  it("非法画布尺寸不产生 NaN / Infinity", () => {
    const fit = fitModel(0, 0, MODEL_BOUNDS, FIT_PRESETS.desktop);
    expect(Number.isFinite(fit.scale)).toBe(true);
    expect(Number.isFinite(fit.x)).toBe(true);
    expect(Number.isFinite(fit.y)).toBe(true);
  });
});

describe("fitModel：属性测试（任意画布宽高比，人物包围盒都在画布内，S6a-fix2 §3）", () => {
  it("任意 canvasW / canvasH：四角映射后都在归一化画布内", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 8000, noNaN: true }),
        fc.double({ min: 1, max: 8000, noNaN: true }),
        fc.constantFrom("desktop", "mobile" as const),
        (canvasW, canvasH, presetName) => {
          const fit = fitModel(canvasW, canvasH, MODEL_BOUNDS, FIT_PRESETS[presetName]);
          const normCanvasW = (canvasW / canvasH) * 2;
          const normCanvasH = 2;
          const corners = [
            { x: MODEL_BOUNDS.left, y: MODEL_BOUNDS.bottom },
            { x: MODEL_BOUNDS.right, y: MODEL_BOUNDS.bottom },
            { x: MODEL_BOUNDS.left, y: MODEL_BOUNDS.top },
            { x: MODEL_BOUNDS.right, y: MODEL_BOUNDS.top },
          ];
          if (!Number.isFinite(fit.scale) || !Number.isFinite(fit.x) || !Number.isFinite(fit.y)) return false;
          for (const c of corners) {
            const mapped = mapPoint(c, fit);
            const hx = normCanvasW / 2;
            const hy = normCanvasH / 2;
            // 允许极小浮点误差；不应超出画布。
            if (mapped.x < -hx - 1e-6 || mapped.x > hx + 1e-6) return false;
            if (mapped.y < -hy - 1e-6 || mapped.y > hy + 1e-6) return false;
          }
          return true;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("任意预设：可见区域高度 = heightRatio * 画布高（除非宽度受限）", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 200, max: 4000, noNaN: true }),
        fc.double({ min: 200, max: 4000, noNaN: true }),
        (canvasW, canvasH) => {
          const preset = FIT_PRESETS.desktop;
          const fit = fitModel(canvasW, canvasH, MODEL_BOUNDS, preset);
          const normCanvasW = (canvasW / canvasH) * 2;
          const boundsW = MODEL_BOUNDS.right - MODEL_BOUNDS.left;
          const boundsH = MODEL_BOUNDS.top - MODEL_BOUNDS.bottom;
          const heightLimited = (preset.heightRatio * 2) / boundsH <= normCanvasW / boundsW;
          const expected = heightLimited ? preset.heightRatio * 2 : (normCanvasW / boundsW) * boundsH;
          return Math.abs(fit.scale * boundsH - expected) < 1e-6;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("§5.2：手机端顶部安全区下移后，人物包围盒顶部低于标题胶囊底部", () => {
    // 与 live.css 的 --mobile-top-safe 一致（96px + safe-area-inset-top；Playwright 下 safe-top=0）。
    const MOBILE_TOP_SAFE_PX = 96;
    const TITLE_PILL_BOTTOM_PX = 96; // 顶栏 + 标题胶囊底部高度（与 --mobile-top-safe 一致）
    for (const [w, h] of [[390, 844], [430, 932], [360, 780], [412, 915]] as const) {
      const canvasH = h - MOBILE_TOP_SAFE_PX;
      const modelTopInCanvas = modelBBoxTopPx(w, canvasH, MODEL_BOUNDS, LIVE_FIT_PRESETS.liveMobile);
      const modelTopOnScreen = MOBILE_TOP_SAFE_PX + modelTopInCanvas;
      expect(modelTopOnScreen, `${w}x${h} 头顶被标题胶囊遮挡`).toBeGreaterThanOrEqual(TITLE_PILL_BOTTOM_PX);
    }
  });

  it("modelBBoxTopPx：人物顶部在画布内且非负", () => {
    const top = modelBBoxTopPx(390, 748, MODEL_BOUNDS, LIVE_FIT_PRESETS.liveMobile);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(748);
  });

  it("任意对称包围盒 + 零偏移：映射后中心在原点", () => {
    const symmetric: ModelBounds = { left: -0.3, right: 0.3, bottom: -0.5, top: 0.5 };
    fc.assert(
      fc.property(
        fc.double({ min: 100, max: 3000, noNaN: true }),
        fc.double({ min: 100, max: 3000, noNaN: true }),
        (w, h) => {
          const fit = fitModel(w, h, symmetric, FIT_PRESETS.desktop);
          const center = mapPoint({ x: 0, y: 0 }, fit);
          return Math.abs(center.x) < 1e-9 && Math.abs(center.y) < 1e-9;
        },
      ),
      { numRuns: 300 },
    );
  });
});
