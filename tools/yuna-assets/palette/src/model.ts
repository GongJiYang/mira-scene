/**
 * 把 Cubism Core 的模型对象 + cdi3.json 的 part 中文名整理成纯数据类型（S6e §1）。
 *
 * Core 只给 part id（`Part` / `Part2`…），中文名在 `yuna.cdi3.json` 的 `Parts` 里，
 * 这里按 id 合并。输出 `DrawableInfo[]` / `PartInfo[]`，供纯函数 `selectClothingDrawables`
 * 使用。
 */
import type { CubismModel } from "./core.js";
import type { DrawableInfo, PartInfo } from "./pure.js";

type Cdi3 = {
  Parts?: { Id?: unknown; Name?: unknown }[];
};

/** 从 cdi3.json 抽 `id → 中文名`。 */
export function partNameMap(cdi3Json: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof cdi3Json !== "object" || cdi3Json === null) return map;
  const parts = (cdi3Json as Cdi3).Parts;
  if (!Array.isArray(parts)) return map;
  for (const entry of parts) {
    if (typeof entry?.Id === "string" && typeof entry?.Name === "string") {
      map.set(entry.Id, entry.Name);
    }
  }
  return map;
}

/** 抽出所有 part（中文名缺失时回退成 id）。 */
export function extractParts(model: CubismModel, names: Map<string, string>): PartInfo[] {
  const parts: PartInfo[] = [];
  for (let index = 0; index < model.parts.count; index += 1) {
    const id = model.parts.ids[index] ?? `Part#${index}`;
    parts.push({
      index,
      id,
      name: names.get(id) ?? id,
      parentIndex: model.parts.parentIndices[index] ?? -1,
    });
  }
  return parts;
}

/** 抽出所有 drawable 的纯数据。 */
export function extractDrawables(model: CubismModel): DrawableInfo[] {
  const drawables: DrawableInfo[] = [];
  for (let index = 0; index < model.drawables.count; index += 1) {
    drawables.push({
      index,
      textureIndex: model.drawables.textureIndices[index] ?? -1,
      parentPartIndex: model.drawables.parentPartIndices[index] ?? -1,
      uvs: model.drawables.vertexUvs[index] ?? new Float32Array(0),
      indices: model.drawables.indices[index] ?? new Uint16Array(0),
    });
  }
  return drawables;
}
