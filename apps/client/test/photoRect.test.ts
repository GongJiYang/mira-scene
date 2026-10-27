import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FACE_BOX,
  PHOTO_MAX_WIDTH_RATIO,
  faceBoxRect,
  photoRect,
  rectsIntersect,
  type Size,
} from "../src/stage/photoRect";

const EPS = 0.5;

function inside(rect: { left: number; top: number; width: number; height: number }, stage: Size): boolean {
  return (
    rect.left >= -EPS &&
    rect.top >= -EPS &&
    rect.left + rect.width <= stage.width + EPS &&
    rect.top + rect.height <= stage.height + EPS
  );
}

describe("photoRect（S5 §4 ②）", () => {
  it("2:3 舞台上：落在舞台内、与脸部框不相交、水平居中", () => {
    const stage: Size = { width: 390, height: 585 };
    const rect = photoRect(stage);

    expect(inside(rect, stage)).toBe(true);
    expect(rectsIntersect(rect, faceBoxRect(stage))).toBe(false);
    expect(rect.left + rect.width / 2).toBeCloseTo(stage.width / 2, 5);
  });

  it("照片被放得比桌角态大，但不超过舞台宽度的上限", () => {
    const stage: Size = { width: 1000, height: 1500 };
    const rect = photoRect(stage);
    expect(rect.width).toBeLessThanOrEqual(PHOTO_MAX_WIDTH_RATIO * stage.width + EPS);
    expect(rect.width).toBeGreaterThan(0.3 * stage.width);
  });

  it("rectsIntersect：只有正面积重叠才算相交（贴边不算）", () => {
    const a = { left: 0, top: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { left: 10, top: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsIntersect(a, { left: 9, top: 0, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect(a, { left: 0, top: 0, width: 0, height: 0 })).toBe(false);
  });

  it("faceBox 用舞台百分比表示，换算到像素随时间成比例", () => {
    const small = faceBoxRect({ width: 300, height: 450 });
    const large = faceBoxRect({ width: 600, height: 900 });
    expect(large.left).toBeCloseTo(small.left * 2, 5);
    expect(large.top).toBeCloseTo(small.top * 2, 5);
    expect(FACE_BOX.top).toBeGreaterThan(0);
    expect(FACE_BOX.top + FACE_BOX.height).toBeLessThan(1);
  });
});

describe("photoRect：属性测试（架构关卡 §4 · 后置条件）", () => {
  it("对随机舞台尺寸：落在舞台内，且与 faceBox 像素区域不相交（1000 次）", () => {
    fc.assert(
      fc.property(
        // 舞台框宽度 280–1200px；高度按 2:3（±2% 抖动模拟亚像素/圆角）。
        fc.integer({ min: 280, max: 1200 }),
        fc.integer({ min: -20, max: 20 }),
        (width, jitterPerMille) => {
          const height = width * 1.5 * (1 + jitterPerMille / 1000);
          const stage: Size = { width, height };
          const rect = photoRect(stage);
          const face = faceBoxRect(stage);
          return inside(rect, stage) && !rectsIntersect(rect, face);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
