/**
 * 纯函数核心（S6e §0「函数式核心」）。
 *
 * 这里没有任何 I/O、不引用 Cubism Core、不读文件：输入是普通数据（drawable / part / 位图 /
 * 变换规则），输出是新数据。CLI 外壳负责把 Cubism Core 的数据整理成这里的输入类型。
 *
 * 两条不变量（§0「契约」）：
 *   1. alpha 逐像素不变 —— 由 `recolorPixel` / `applyMasked` 保证；
 *   2. 蒙版外的像素逐像素不变 —— 由 `applyMasked` 保证。
 */
import type { RgbaImage } from "./png.js";

/** 一个 drawable 的核心数据（从 Cubism Core 抽出，纯数据）。 */
export type DrawableInfo = {
  index: number;
  /** 所属贴图下标（textureIndices）。 */
  textureIndex: number;
  /** 所属 part 下标（parentPartIndices）。 */
  parentPartIndex: number;
  /** UV 列表：`u1, v1, u2, v2, ...`（每个顶点两个数）。 */
  uvs: ArrayLike<number>;
  /** 三角形索引（每 3 个构成一个三角形）。 */
  indices: ArrayLike<number>;
};

/** 一个 part 的核心数据。 */
export type PartInfo = {
  index: number;
  id: string;
  name: string;
  parentIndex: number;
};

/** 规则文件里对 part 名字的匹配规则。 */
export type ClothingRules = {
  /** 名字包含任一关键词即归入 `clothing`（如 衣、裙、领…）。 */
  include: string[];
  /** 名字包含任一关键词即排除，优先级高于 include（如 脸、眼、头发…）。 */
  exclude: string[];
};

/** part 的类别（目前只区分衣服与非衣服）。 */
export type PartCategory = "clothing" | "other";

/** 一个 part 的分类结果（供报告打印）。 */
export type PartClassification = {
  partId: string;
  name: string;
  category: PartCategory;
  /** 命中的关键词（报告用）。 */
  matched: string;
  /** 直属该 part 的 drawable 数（不含子 part）。 */
  drawableCount: number;
};

/**
 * 把 part 名字映射到类别（§1 规则）。
 *
 * 排除优先：名字命中 `exclude` 任一关键词 → `other`；否则命中 `include` → `clothing`；
 * 都不命中 → `other`（默认不动，安全）。
 */
export function classifyPartName(name: string, rules: ClothingRules): { category: PartCategory; matched: string } {
  const excluded = rules.exclude.find((keyword) => keyword.length > 0 && name.includes(keyword));
  if (excluded !== undefined) return { category: "other", matched: `exclude:${excluded}` };
  const included = rules.include.find((keyword) => keyword.length > 0 && name.includes(keyword));
  if (included !== undefined) return { category: "clothing", matched: `include:${included}` };
  return { category: "other", matched: "" };
}

/**
 * 选出属于衣服的 drawable，并给每个 part 分类（§1）。
 *
 * 继承语义：从自己沿父链向上，取**最近**一个 direct 判定非 other 的节点作为类别；
 * 自己 direct 命中 exclude 最强（优先级最高）。这样「下半身(clothing)→腿(exclude)→鞋(clothing)」
 * 的链上，腿保持 other（皮肤不染色），鞋仍算 clothing。
 */
export function selectClothingDrawables(
  drawables: readonly DrawableInfo[],
  parts: readonly PartInfo[],
  rules: ClothingRules,
): { drawableIndices: number[]; classifications: PartClassification[] } {
  // directCategory: 仅看自己名字；exclude 命中记为 "excluded"（显式阻断继承）。
  const directCategory: ("clothing" | "excluded" | "other")[] = parts.map((part) => {
    const { category } = classifyPartName(part.name, rules);
    if (category === "clothing") return "clothing";
    const excluded = rules.exclude.some((k) => k.length > 0 && part.name.includes(k));
    return excluded ? "excluded" : "other";
  });

  const resolved: PartCategory[] = parts.map((_, index) => {
    let cursor = index;
    const guard = new Set<number>();
    while (cursor >= 0 && cursor < parts.length && !guard.has(cursor)) {
      guard.add(cursor);
      const direct = directCategory[cursor]!;
      if (direct === "clothing") return "clothing";
      if (direct === "excluded") return "other";
      cursor = parts[cursor]!.parentIndex;
    }
    return "other";
  });

  const drawableCountByPart = new Map<number, number>();
  for (const drawable of drawables) {
    drawableCountByPart.set(drawable.parentPartIndex, (drawableCountByPart.get(drawable.parentPartIndex) ?? 0) + 1);
  }

  const classifications: PartClassification[] = parts.map((part) => ({
    partId: part.id,
    name: part.name,
    category: resolved[part.index] ?? "other",
    matched: classifyPartName(part.name, rules).matched,
    drawableCount: drawableCountByPart.get(part.index) ?? 0,
  }));

  const drawableIndices = drawables
    .filter((drawable) => resolved[drawable.parentPartIndex] === "clothing")
    .map((drawable) => drawable.index);

  return { drawableIndices, classifications };
}

/**
 * 把一组 drawable 的三角形按 UV 光栅化到 `width x height` 的蒙版（§1）。
 *
 * 返回 `Uint8Array`（长 `width*height`）：255 = 衣服，0 = 非衣服。
 * UV 的 v 轴：Cubism 贴图 UV 原点在左上、v 向下，与本项目位图行序一致，直接用。
 */
export function rasterizeTriangles(
  triangles: readonly DrawableInfo[],
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const drawable of triangles) {
    const uvs = drawable.uvs;
    const indices = drawable.indices;
    const vertexCount = Math.floor(uvs.length / 2);
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = indices[i]!;
      const b = indices[i + 1]!;
      const c = indices[i + 2]!;
      if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
      const ax = uvs[a * 2]! * width;
      const ay = uvs[a * 2 + 1]! * height;
      const bx = uvs[b * 2]! * width;
      const by = uvs[b * 2 + 1]! * height;
      const cx = uvs[c * 2]! * width;
      const cy = uvs[c * 2 + 1]! * height;
      fillTriangle(mask, width, height, ax, ay, bx, by, cx, cy);
    }
  }
  return mask;
}

/** 把单个三角形的覆盖区域（按像素中心规则）写进蒙版。 */
function fillTriangle(
  mask: Uint8Array,
  width: number,
  height: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): void {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
  const area = edge(ax, ay, bx, by, cx, cy);
  if (area === 0) return;

  for (let y = minY; y <= maxY; y += 1) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const w0 = edge(bx, by, cx, cy, px, py);
      const w1 = edge(cx, cy, ax, ay, px, py);
      const w2 = edge(ax, ay, bx, by, px, py);
      const inside = area > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0;
      if (inside) mask[y * width + x] = 255;
    }
  }
}

function edge(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/**
 * 蒙版膨胀 `radius` 像素（§1「边缘做 1px 膨胀，避免接缝」）。
 *
 * 用方形结构元的形态学膨胀，保证相邻三角形之间不出现 1px 缝隙。
 */
export function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const source = mask;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hit = false;
      for (let dy = -radius; dy <= radius && !hit; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (source[ny * width + nx] !== 0) {
            hit = true;
            break;
          }
        }
      }
      if (hit) out[y * width + x] = 255;
    }
  }
  return out;
}

/** 一条「色相区间 → 目标色相」的映射规则（§2）。 */
export type HueRule = {
  /** 匹配色相区间下界（度，0–360，含）。 */
  from: number;
  /** 匹配色相区间上界（度，含）。`to > from`。 */
  to: number;
  /** 目标色相（度）。 */
  target: number;
  /** 饱和度系数（0 表示完全去饱和）。 */
  saturation: number;
  /** 亮度偏移（-1..1，§2 要求 ≤ ±0.05）。 */
  lightnessShift: number;
  /** 低于该饱和度的像素视为「黑白灰」，不参与变换（§2）。 */
  minSaturation: number;
};

/** 一个配色变体：一组色相区间映射。 */
export type Palette = {
  name: string;
  rules: HueRule[];
};

/** 一次像素变换的中间表示（报告与测试用）。 */
export type PixelTransform = {
  hue: number;
  saturation: number;
  lightness: number;
};

/**
 * 判断像素是否命中某条规则（MIN 饱和度门槛 + 色相区间，含环绕）。
 * 亮度与 alpha 不参与判断。
 */
export function matchesRule(rgba: readonly [number, number, number, number], rule: HueRule): boolean {
  const [r, g, b] = rgba;
  const hsl = rgbToHsl(r, g, b);
  if (hsl.saturation < rule.minSaturation) return false;
  return hueInRange(hsl.hue, rule.from, rule.to);
}

/** 色相是否落在 `[from, to]` 区间内（支持跨 0° 的环绕区间）。 */
export function hueInRange(hue: number, from: number, to: number): boolean {
  const f = normalizeHue(from);
  const t = normalizeHue(to);
  const h = normalizeHue(hue);
  if (f <= t) return h >= f && h <= t;
  return h >= f || h <= t;
}

function normalizeHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

/**
 * 对单个像素应用配色变换（§2）：只改 RGB，alpha 原样返回。
 *
 * - 不命中任何规则 → 原样返回（黑白灰不动，保证黑裙仍是黑）。
 * - 命中 → 色相改为目标色相，饱和度乘系数（夹到 0–1），亮度加偏移（夹到 0–1）。
 */
export function recolorPixel(
  rgba: readonly [number, number, number, number],
  rules: readonly HueRule[],
): [number, number, number, number] {
  const [r, g, b, a] = rgba;
  for (const rule of rules) {
    if (!matchesRule(rgba, rule)) continue;
    const hsl = rgbToHsl(r, g, b);
    const target = {
      h: normalizeHue(rule.target),
      s: clamp01(hsl.saturation * rule.saturation),
      l: clamp01(hsl.lightness + rule.lightnessShift),
    };
    const [nr, ng, nb] = hslToRgb(target.h, target.s, target.l);
    return [nr, ng, nb, a];
  }
  return [r, g, b, a];
}

/**
 * 把蒙版内的像素逐个应用变换（§0 契约）。
 *
 * 蒙版为 0 的像素**原样拷贝**（逐像素不变）；蒙版非 0 的像素用 `recolorPixel`。
 * 所有像素的 alpha 都原样保留（`recolorPixel` 不改 alpha，且拷贝路径逐字节相同）。
 * 返回新位图，不修改入参。
 */
export function applyMasked(texture: RgbaImage, mask: Uint8Array, rules: readonly HueRule[]): RgbaImage {
  const { width, height, data } = texture;
  if (mask.length !== width * height) {
    throw new Error(`蒙版尺寸不符：期望 ${width * height}，实际 ${mask.length}`);
  }
  const out = new Uint8Array(data.length);
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    if (mask[p] === 0) {
      out[i] = data[i]!;
      out[i + 1] = data[i + 1]!;
      out[i + 2] = data[i + 2]!;
      out[i + 3] = data[i + 3]!;
      continue;
    }
    const [r, g, b, a] = recolorPixel(
      [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!],
      rules,
    );
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = a;
  }
  return { width, height, data: out };
}

/** RGB（0–255）→ HSL（h 度，s/l 0–1）。 */
export function rgbToHsl(r: number, g: number, b: number): PixelTransform {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { hue: h, saturation: s, lightness: l };
}

/** HSL（h 度，s/l 0–1）→ RGB（0–255，四舍五入）。 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = normalizeHue(h) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hueToRgb(p, q, hue + 1 / 3);
  const g = hueToRgb(p, q, hue);
  const b = hueToRgb(p, q, hue - 1 / 3);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
