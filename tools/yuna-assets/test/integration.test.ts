/**
 * 集成测试（S6e §0「测试奖杯」）：跑一遍真实模型，核对两条不变量。
 *
 * 不变量：
 *   1. alpha 通道逐像素不变；
 *   2. 蒙版外的像素逐像素不变。
 *
 * 不重跑 CLI（避免重复写产物）：直接读 `palettes/<name>/texture_XX.png` 与原贴图逐像素比对。
 * 若产物不存在则先跑一遍构建。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import {
  analyze,
  DILATE_RADIUS,
  OUT_MODEL_DIR,
  PALETTE_DIR,
  readJson,
  readTexture,
  textureName,
} from "../palette/src/cli.js";
import { decodePng } from "../palette/src/png.js";
import { dilateMask, rasterizeTriangles, type DrawableInfo } from "../palette/src/pure.js";
import { parsePalettes, parseRules } from "../palette/src/schema.js";
import { readFileSync } from "node:fs";
import { run } from "../palette/src/build.js";

const palettesParsed = parsePalettes(readJson(join(PALETTE_DIR, "palettes.json")));
if (!palettesParsed.ok) throw new Error(`palettes.json 非法：${palettesParsed.error}`);
const PALETTES = palettesParsed.value;

beforeAll(async () => {
  const missing = PALETTES.some((p) => !existsSync(join(OUT_MODEL_DIR, p.name, textureName(0))));
  if (missing) {
    await run();
  }
}, 600_000);

describe("真实模型配色变体（不变量核对）", () => {
  it("每个变体：alpha 逐像素不变，蒙版外像素逐像素不变", async () => {
    const rulesParsed = parseRules(readJson(join(PALETTE_DIR, "rules.json")));
    if (!rulesParsed.ok) throw new Error(rulesParsed.error);
    const analysis = await analyze(rulesParsed.value);

    // 重建每张 source 贴图的蒙版（与构建时同一算法），用于判断「蒙版外」。
    const set = new Set(analysis.clothingDrawableIndices);
    const byTexture = new Map<number, DrawableInfo[]>();
    for (const d of analysis.drawables) {
      if (!set.has(d.index)) continue;
      const list = byTexture.get(d.textureIndex) ?? [];
      list.push(d);
      byTexture.set(d.textureIndex, list);
    }

    for (const palette of PALETTES) {
      for (let index = 0; index < analysis.textureCount; index += 1) {
        const source = readTexture(index);
        const variantPath = join(OUT_MODEL_DIR, palette.name, textureName(index));
        expect(existsSync(variantPath), `缺产物 ${variantPath}`).toBe(true);
        const variant = decodePng(readFileSync(variantPath));

        expect(variant.width).toBe(source.width);
        expect(variant.height).toBe(source.height);

        const clothing = byTexture.get(index) ?? [];
        const mask = dilateMask(
          rasterizeTriangles(clothing, source.width, source.height),
          source.width,
          source.height,
          DILATE_RADIUS,
        );

        let alphaViolations = 0;
        let outsideViolations = 0;
        for (let p = 0; p < source.width * source.height; p += 1) {
          const i = p * 4;
          if (variant.data[i + 3] !== source.data[i + 3]) alphaViolations += 1;
          if (
            mask[p] === 0 &&
            (variant.data[i] !== source.data[i] ||
              variant.data[i + 1] !== source.data[i + 1] ||
              variant.data[i + 2] !== source.data[i + 2])
          ) {
            outsideViolations += 1;
          }
        }
        expect(alphaViolations, `${palette.name}/${textureName(index)} alpha 被改`).toBe(0);
        expect(outsideViolations, `${palette.name}/${textureName(index)} 蒙版外被改`).toBe(0);
      }
    }
  }, 300_000);

  it("每个变体至少改动了一些像素（紫色衣服存在）", () => {
    for (const palette of PALETTES) {
      let changed = 0;
      for (let index = 0; index < 4; index += 1) {
        const source = readTexture(index);
        const variant = decodePng(readFileSync(join(OUT_MODEL_DIR, palette.name, textureName(index))));
        for (let i = 0; i < source.data.length; i += 4) {
          if (
            variant.data[i] !== source.data[i] ||
            variant.data[i + 1] !== source.data[i + 1] ||
            variant.data[i + 2] !== source.data[i + 2]
          ) {
            changed += 1;
          }
        }
      }
      expect(changed, `${palette.name} 没有改动任何像素`).toBeGreaterThan(1000);
    }
  }, 300_000);
});
