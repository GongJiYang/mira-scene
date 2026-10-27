/**
 * 纯函数属性测试（S6e §0「测试奖杯」）。
 *
 * fast-check 任意像素与变换：
 *   1. alpha 逐像素不变；
 *   2. 亮度变化 ≤ 给定容差（lightnessShift ≤ ±0.05，加 RGB 往返量化误差）；
 *   3. 蒙版外像素逐像素不变（applyMasked）。
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyMasked,
  dilateMask,
  hueInRange,
  matchesRule,
  rasterizeTriangles,
  recolorPixel,
  rgbToHsl,
  selectClothingDrawables,
  type ClothingRules,
  type DrawableInfo,
  type HueRule,
  type PartInfo,
} from "../palette/src/pure.js";
import type { RgbaImage } from "../palette/src/png.js";

const rgbaArb = fc.tuple(
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
  fc.integer({ min: 0, max: 255 }),
) as fc.Arbitrary<[number, number, number, number]>;

const hueRuleArb: fc.Arbitrary<HueRule> = fc.record({
  from: fc.integer({ min: 0, max: 359 }),
  to: fc.integer({ min: 0, max: 360 }),
  target: fc.integer({ min: 0, max: 359 }),
  saturation: fc.double({ min: 0, max: 1, noNaN: true }),
  lightnessShift: fc.double({ min: -0.05, max: 0.05, noNaN: true }),
  minSaturation: fc.double({ min: 0.01, max: 1, noNaN: true }),
}).filter((r) => r.from !== r.to);

const rulesArb = fc.array(hueRuleArb, { minLength: 1, maxLength: 3 });

describe("recolorPixel", () => {
  it("alpha 逐像素不变（任意像素与规则）", () => {
    fc.assert(
      fc.property(rgbaArb, rulesArb, (rgba, rules) => {
        const out = recolorPixel(rgba, rules);
        expect(out[3]).toBe(rgba[3]);
      }),
    );
  });

  it("亮度变化 ≤ 0.05 + 量化容差（命中规则时）", () => {
    fc.assert(
      fc.property(rgbaArb, rulesArb, (rgba, rules) => {
        const out = recolorPixel(rgba, rules);
        const before = rgbToHsl(rgba[0], rgba[1], rgba[2]).lightness;
        const after = rgbToHsl(out[0], out[1], out[2]).lightness;
        // HSL→RGB 四舍五入引入的亮度误差 ≤ 3/255；规则亮度偏移 ≤ 0.05。
        expect(Math.abs(after - before)).toBeLessThanOrEqual(0.05 + 3 / 255 + 1e-9);
      }),
    );
  });

  it("不命中规则时像素原样返回", () => {
    fc.assert(
      fc.property(rgbaArb, (rgba) => {
        const miss: HueRule = {
          from: 0,
          to: 360,
          target: 120,
          saturation: 1,
          lightnessShift: 0,
          minSaturation: 1.1, // 高于任何像素饱和度 → 永不命中
        };
        const out = recolorPixel(rgba, [miss]);
        expect(out).toEqual(rgba);
      }),
    );
  });

  it("黑白灰（低饱和度）像素不动（黑裙仍是黑）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }).chain((v) => fc.tuple(fc.constant(v), fc.constant(v), fc.constant(v), fc.integer({ min: 0, max: 255 }))),
        rulesArb,
        (rgba, rules) => {
          const out = recolorPixel(rgba as [number, number, number, number], rules);
          expect(out).toEqual(rgba);
        },
      ),
    );
  });
});

describe("hueInRange", () => {
  it("区间内外的判定与环绕一致", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 359 }),
        fc.integer({ min: 0, max: 360 }),
        fc.integer({ min: 0, max: 719 }),
        (from, to, hueRaw) => {
          if (from === to) return;
          const hue = hueRaw % 360;
          const result = hueInRange(hue, from, to);
          const f = from % 360;
          const t = to % 360;
          const expected = f <= t ? hue >= f && hue <= t : hue >= f || hue <= t;
          expect(result).toBe(expected);
        },
      ),
    );
  });
});

describe("applyMasked", () => {
  const imageArb = fc
    .record({
      width: fc.integer({ min: 1, max: 16 }),
      height: fc.integer({ min: 1, max: 16 }),
    })
    .chain(({ width, height }) =>
      fc
        .array(fc.integer({ min: 0, max: 255 }), {
          minLength: width * height * 4,
          maxLength: width * height * 4,
        })
        .map((data) => ({ width, height, data: Uint8Array.from(data) })),
    );

  it("蒙版外像素逐像素不变；所有像素 alpha 不变", () => {
    fc.assert(
      fc.property(
        imageArb,
        fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 256, maxLength: 256 }),
        rulesArb,
        (image, maskBits, rules) => {
          const { width, height, data } = image;
          const mask = Uint8Array.from({ length: width * height }, (_, i) => (maskBits[i] ? 255 : 0));
          const out = applyMasked({ width, height, data }, mask, rules);
          for (let p = 0; p < width * height; p += 1) {
            const i = p * 4;
            expect(out.data[i + 3]).toBe(data[i + 3]); // alpha 不变
            if (mask[p] === 0) {
              expect(out.data[i]).toBe(data[i]);
              expect(out.data[i + 1]).toBe(data[i + 1]);
              expect(out.data[i + 2]).toBe(data[i + 2]);
            }
          }
        },
      ),
    );
  });

  it("返回新位图，不修改入参", () => {
    const image: RgbaImage = {
      width: 2,
      height: 1,
      data: Uint8Array.from([200, 100, 255, 255, 30, 200, 100, 128]),
    };
    const mask = Uint8Array.from([255, 0]);
    const rules: HueRule[] = [
      { from: 235, to: 310, target: 340, saturation: 0.85, lightnessShift: 0.03, minSaturation: 0.18 },
    ];
    const before = image.data.slice();
    const out = applyMasked(image, mask, rules);
    expect(image.data).toEqual(before);
    expect(out.data).not.toBe(image.data);
    // 蒙版内紫色像素应被改动；蒙版外像素原样。
    expect(out.data[4]).toBe(image.data[4]);
    expect(out.data[5]).toBe(image.data[5]);
    expect(out.data[6]).toBe(image.data[6]);
  });
});

describe("matchesRule", () => {
  it("饱和度低于 minSaturation 永不命中", () => {
    fc.assert(
      fc.property(rgbaArb, hueRuleArb, (rgba, rule) => {
        const s = rgbToHsl(rgba[0], rgba[1], rgba[2]).saturation;
        if (s < rule.minSaturation) {
          expect(matchesRule(rgba, rule)).toBe(false);
        }
      }),
    );
  });
});

describe("rasterizeTriangles / dilateMask", () => {
  it("单个三角形覆盖其内部像素，蒙版长度 = w*h", () => {
    const drawable: DrawableInfo = {
      index: 0,
      textureIndex: 0,
      parentPartIndex: 0,
      uvs: Float32Array.from([0.1, 0.1, 0.9, 0.1, 0.5, 0.9]),
      indices: Uint16Array.from([0, 1, 2]),
    };
    const mask = rasterizeTriangles([drawable], 100, 100);
    expect(mask.length).toBe(10000);
    let covered = 0;
    for (const v of mask) if (v !== 0) covered += 1;
    expect(covered).toBeGreaterThan(1000);
    expect(mask[50 * 100 + 50]).toBe(255); // 中心必在内
    expect(mask[0]).toBe(0); // 左上角在外
  });

  it("膨胀只增不减，且 radius 0 等于原样", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 100, maxLength: 100 }),
        (bits) => {
          const mask = Uint8Array.from(bits.map((b) => (b ? 255 : 0)));
          const dilated = dilateMask(mask, 10, 10, 1);
          for (let i = 0; i < 100; i += 1) {
            if (mask[i] !== 0) expect(dilated[i]).toBe(255);
          }
          const same = dilateMask(mask, 10, 10, 0);
          expect(same).toEqual(mask);
        },
      ),
    );
  });
});

describe("selectClothingDrawables", () => {
  const rules: ClothingRules = {
    include: ["衣", "裙", "发带", "下半身", "鞋"],
    exclude: ["脸", "头发", "马尾", "腿"],
  };

  function makeParts(): PartInfo[] {
    return [
      { index: 0, id: "P0", name: "下半身", parentIndex: -1 },
      { index: 1, id: "P1", name: "躯干", parentIndex: 0 },
      { index: 2, id: "P2", name: "左腿", parentIndex: 0 },
      { index: 3, id: "P3", name: "鞋子", parentIndex: 2 },
      { index: 4, id: "P4", name: "脸部", parentIndex: -1 },
      { index: 5, id: "P5", name: "左侧发带", parentIndex: -1 },
      { index: 6, id: "P6", name: "右马尾", parentIndex: -1 },
    ];
  }

  function makeDrawables(): DrawableInfo[] {
    return [0, 1, 2, 3, 4, 5, 6].map((partIndex) => ({
      index: partIndex,
      textureIndex: 0,
      parentPartIndex: partIndex,
      uvs: new Float32Array(0),
      indices: new Uint16Array(0),
    }));
  }

  it("衣服 part 与其未排除子 part 算 clothing；显式 exclude 阻断继承", () => {
    const { drawableIndices, classifications } = selectClothingDrawables(makeDrawables(), makeParts(), rules);
    const byId = new Map(classifications.map((c) => [c.partId, c.category]));
    expect(byId.get("P0")).toBe("clothing"); // 下半身
    expect(byId.get("P1")).toBe("clothing"); // 躯干（继承）
    expect(byId.get("P2")).toBe("other"); // 左腿（exclude 阻断）
    expect(byId.get("P3")).toBe("clothing"); // 鞋（自己 include）
    expect(byId.get("P4")).toBe("other"); // 脸
    expect(byId.get("P5")).toBe("clothing"); // 发带
    expect(byId.get("P6")).toBe("other"); // 马尾
    expect(drawableIndices.sort()).toEqual([0, 1, 3, 5]);
  });

  it("任意 part 树：exclude 命中的 part 永不归 clothing", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.constantFrom("衣服", "裙子", "脸部", "头发", "腿", "组 1"),
            parent: fc.integer({ min: -1, max: 6 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (rawParts) => {
          const parts: PartInfo[] = rawParts.map((p, i) => ({
            index: i,
            id: `P${i}`,
            name: p.name,
            parentIndex: p.parent < i ? p.parent : -1,
          }));
          const drawables: DrawableInfo[] = parts.map((p) => ({
            index: p.index,
            textureIndex: 0,
            parentPartIndex: p.index,
            uvs: new Float32Array(0),
            indices: new Uint16Array(0),
          }));
          const { classifications } = selectClothingDrawables(drawables, parts, rules);
          for (const c of classifications) {
            if (rules.exclude.some((k) => c.name.includes(k))) {
              expect(c.category).toBe("other");
            }
          }
        },
      ),
    );
  });
});
