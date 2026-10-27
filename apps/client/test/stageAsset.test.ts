import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pickStageAsset } from "../src/stage/layers";

describe("pickStageAsset（S5 §4 ①）", () => {
  it("按舞台框尺寸判断：高于宽为 portrait，否则 landscape", () => {
    expect(pickStageAsset(200, 300)).toBe("portrait");
    expect(pickStageAsset(300, 200)).toBe("landscape");
    expect(pickStageAsset(500, 500)).toBe("portrait");
  });

  it("舞台固定 2:3 → 恒为 portrait", () => {
    expect(pickStageAsset(390, 585)).toBe("portrait");
    expect(pickStageAsset(720, 1080)).toBe("portrait");
  });
});

describe("pickStageAsset：属性测试（架构关卡 §4 · 后置条件）", () => {
  it("对任意 2:3 舞台尺寸都返回 portrait（相机所在区域不会被裁掉）（1000 次）", () => {
    fc.assert(
      fc.property(fc.integer({ min: 280, max: 1200 }), (width) => {
        const height = width * 1.5;
        return pickStageAsset(width, height) === "portrait";
      }),
      { numRuns: 1000 },
    );
  });
});
