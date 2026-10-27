/**
 * 配色变体构建入口（S6e §2/§3）。
 *
 * 流程：读规则 → 选衣服 drawable → 光栅化蒙版 → 对每个变体变换贴图 → 写变体贴图 + 对比预览。
 * 可重复运行：输出目录先清空再写。
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  analyze,
  DILATE_RADIUS,
  ensureDir,
  OUT_MODEL_DIR,
  OUT_PREVIEW_DIR,
  PALETTE_DIR,
  readJson,
  readTexture,
  textureName,
  writeFile,
} from "./cli.js";
import { encodePng, type RgbaImage } from "./png.js";
import {
  applyMasked,
  dilateMask,
  rasterizeTriangles,
  type DrawableInfo,
  type Palette,
} from "./pure.js";
import { parsePalettes, parseRules } from "./schema.js";
import { makePreview } from "./preview.js";

export type BuildOptions = {
  /** 只构建这一个变体；缺省构建全部。 */
  paletteName?: string;
};

export type BuiltPalette = {
  name: string;
  files: { path: string; bytes: number }[];
  /** 相对原图真正被改动的像素数（报告用）。 */
  changedPixels: number;
};

/** 每个贴图下标 → 该贴上属于衣服的 drawable。 */
function groupByTexture(
  drawables: readonly DrawableInfo[],
  indices: readonly number[],
): Map<number, DrawableInfo[]> {
  const set = new Set(indices);
  const map = new Map<number, DrawableInfo[]>();
  for (const drawable of drawables) {
    if (!set.has(drawable.index)) continue;
    const list = map.get(drawable.textureIndex) ?? [];
    list.push(drawable);
    map.set(drawable.textureIndex, list);
  }
  return map;
}

/** 统计真正被改动的像素数（RGB 任一变化）。 */
function countChanged(before: RgbaImage, after: RgbaImage): number {
  let count = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    if (
      before.data[i] !== after.data[i] ||
      before.data[i + 1] !== after.data[i + 1] ||
      before.data[i + 2] !== after.data[i + 2]
    ) {
      count += 1;
    }
  }
  return count;
}

/** 构建一个变体，写出全部贴图，返回产物信息。 */
function buildPalette(
  palette: Palette,
  textureCount: number,
  byTexture: Map<number, DrawableInfo[]>,
  sourceTextures: Map<number, RgbaImage>,
): { built: BuiltPalette; images: Map<number, RgbaImage> } {
  const outDir = join(OUT_MODEL_DIR, palette.name);
  ensureDir(outDir);
  const files: BuiltPalette["files"] = [];
  const images = new Map<number, RgbaImage>();
  let changedPixels = 0;

  for (let index = 0; index < textureCount; index += 1) {
    const source = sourceTextures.get(index);
    if (!source) throw new Error(`缺少贴图 ${textureName(index)}`);
    const clothing = byTexture.get(index) ?? [];
    const mask = dilateMask(
      rasterizeTriangles(clothing, source.width, source.height),
      source.width,
      source.height,
      DILATE_RADIUS,
    );
    const output = applyMasked(source, mask, palette.rules);
    changedPixels += countChanged(source, output);
    images.set(index, output);
    const bytes = encodePng(output);
    const path = join(outDir, textureName(index));
    writeFile(path, bytes);
    files.push({ path, bytes: bytes.length });
  }

  return { built: { name: palette.name, files, changedPixels }, images };
}

/** 主入口：构建选定变体，返回产物。 */
export async function run(options: BuildOptions = {}): Promise<BuiltPalette[]> {
  const rulesParsed = parseRules(readJson(join(PALETTE_DIR, "rules.json")));
  if (!rulesParsed.ok) throw new Error(`rules.json 非法：${rulesParsed.error}`);
  const palettesParsed = parsePalettes(readJson(join(PALETTE_DIR, "palettes.json")));
  if (!palettesParsed.ok) throw new Error(`palettes.json 非法：${palettesParsed.error}`);

  const selected = options.paletteName
    ? palettesParsed.value.filter((p) => p.name === options.paletteName)
    : palettesParsed.value;
  if (selected.length === 0) throw new Error(`找不到变体：${options.paletteName ?? "(全部)"}`);

  const analysis = await analyze(rulesParsed.value);
  const byTexture = groupByTexture(analysis.drawables, analysis.clothingDrawableIndices);

  const sourceTextures = new Map<number, RgbaImage>();
  for (let index = 0; index < analysis.textureCount; index += 1) {
    sourceTextures.set(index, readTexture(index));
  }

  // 输出目录先清空再写（§3 可重复运行）。
  rmSync(OUT_MODEL_DIR, { recursive: true, force: true });
  rmSync(OUT_PREVIEW_DIR, { recursive: true, force: true });
  ensureDir(OUT_MODEL_DIR);
  ensureDir(OUT_PREVIEW_DIR);

  const results: BuiltPalette[] = [];
  for (const palette of selected) {
    const { built, images } = buildPalette(palette, analysis.textureCount, byTexture, sourceTextures);
    results.push(built);
    const preview = makePreview(sourceTextures, images);
    writeFile(join(OUT_PREVIEW_DIR, `preview-${palette.name}.png`), encodePng(preview));
  }

  return results;
}
