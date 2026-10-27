/**
 * CLI 外壳的 I/O 辅助（S6e §3）：路径拼装、模型加载、贴图读写。
 *
 * 纯逻辑在 `pure.ts` / `schema.ts`；这里只做「读文件 / 写文件 / 拼路径」。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCore, loadModel, type CubismCore } from "./core.js";
import { extractDrawables, extractParts, partNameMap } from "./model.js";
import { decodePng, type RgbaImage } from "./png.js";
import {
  selectClothingDrawables,
  type ClothingRules,
  type DrawableInfo,
  type PartClassification,
} from "./pure.js";

// HERE = <repo>/tools/yuna-assets/palette/src
const HERE = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(HERE, "../../../..");
export const PALETTE_DIR = resolve(HERE, "..");
export const MODEL_DIR = join(REPO_ROOT, "apps/client/public/models/yuna");
export const CORE_PATH = join(REPO_ROOT, "apps/client/public/vendor/cubism/live2dcubismcore.min.js");
export const OUT_MODEL_DIR = join(MODEL_DIR, "palettes");
export const OUT_PREVIEW_DIR = join(PALETTE_DIR, "out");

/** 蒙版膨胀半径（§1：1px 膨胀避免接缝）。 */
export const DILATE_RADIUS = 1;
/** 预览图缩放后的宽度（§2）。 */
export const PREVIEW_WIDTH = 1024;

export type AnalyzeResult = {
  textureCount: number;
  drawables: DrawableInfo[];
  classifications: PartClassification[];
  clothingDrawableIndices: number[];
};

/** 读 moc3 + cdi3 + 规则，算出衣服 drawable 与 part 分类清单。 */
export async function analyze(rules: ClothingRules): Promise<AnalyzeResult> {
  const core: CubismCore = await loadCore(CORE_PATH);
  const mocBytes = readFileSync(join(MODEL_DIR, "yuna.moc3"));
  const model = loadModel(core, mocBytes);
  const cdi3 = JSON.parse(readFileSync(join(MODEL_DIR, "yuna.cdi3.json"), "utf8"));
  const names = partNameMap(cdi3);
  const parts = extractParts(model, names);
  const drawables = extractDrawables(model);
  const { drawableIndices, classifications } = selectClothingDrawables(drawables, parts, rules);
  const textureCount = new Set(drawables.map((d) => d.textureIndex).filter((t) => t >= 0)).size;
  return { textureCount, drawables, classifications, clothingDrawableIndices: drawableIndices };
}

/** 读贴图（PNG → RGBA）。 */
export function readTexture(index: number): RgbaImage {
  return decodePng(readFileSync(join(MODEL_DIR, "textures", textureName(index))));
}

export function textureName(index: number): string {
  return `texture_${String(index).padStart(2, "0")}.png`;
}

/** 确保目录存在。 */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** 写文件（自动建父目录）。 */
export function writeFile(path: string, bytes: Uint8Array): void {
  ensureDir(dirname(path));
  writeFileSync(path, bytes);
}

/** 读 JSON。 */
export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
