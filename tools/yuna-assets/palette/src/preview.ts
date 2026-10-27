/**
 * 对比预览合成（S6e §2）：原图与变体左右并排，缩到 `PREVIEW_WIDTH` 宽。
 *
 * 每张贴图单独缩放到预览宽度的一半，然后把所有贴图按行堆叠（原图列 + 变体列共享同一缩略图）。
 */
import { alphaBlend } from "./compose.js";
import type { RgbaImage } from "./png.js";

const PREVIEW_WIDTH = 1024;

/** 用最近邻把位图缩到 `width` 宽（保持宽高比）。 */
export function scaleToWidth(image: RgbaImage, width: number): RgbaImage {
  const scale = width / image.width;
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(image.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor(x / scale));
      const s = (sy * image.width + sx) * 4;
      const d = (y * width + x) * 4;
      data[d] = image.data[s]!;
      data[d + 1] = image.data[s + 1]!;
      data[d + 2] = image.data[s + 2]!;
      data[d + 3] = image.data[s + 3]!;
    }
  }
  return { width, height, data };
}

/**
 * 合成对比预览：每个贴图一行，左边原图、右边变体。
 * `sources` / `variants` 按贴图下标对齐（缺变体则用原图占位）。
 */
export function makePreview(
  sources: Map<number, RgbaImage>,
  variants: Map<number, RgbaImage>,
): RgbaImage {
  const half = Math.floor(PREVIEW_WIDTH / 2);
  const indices = [...sources.keys()].sort((a, b) => a - b);

  const scaled: { source: RgbaImage; variant: RgbaImage }[] = [];
  for (const index of indices) {
    const source = scaleToWidth(sources.get(index)!, half);
    const variant = scaleToWidth(variants.get(index) ?? sources.get(index)!, half);
    scaled.push({ source, variant });
  }

  const rowHeight = scaled.reduce((sum, row) => sum + Math.max(row.source.height, row.variant.height), 0);
  const width = half * 2;
  const out: RgbaImage = { width, height: Math.max(1, rowHeight), data: new Uint8Array(width * Math.max(1, rowHeight) * 4) };

  let y = 0;
  for (const row of scaled) {
    const h = Math.max(row.source.height, row.variant.height);
    blit(out, row.source, 0, y);
    blit(out, row.variant, half, y);
    y += h;
  }
  return out;
}

/** 把 `src` 不透明地贴到 `dst` 的 (dx, dy)。（无缩放，尺寸不匹配时按重叠区贴。） */
function blit(dst: RgbaImage, src: RgbaImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y += 1) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x += 1) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      const [r, g, b, a] = alphaBlend(
        [dst.data[d]!, dst.data[d + 1]!, dst.data[d + 2]!, dst.data[d + 3]!],
        [src.data[s]!, src.data[s + 1]!, src.data[s + 2]!, src.data[s + 3]!],
      );
      dst.data[d] = r;
      dst.data[d + 1] = g;
      dst.data[d + 2] = b;
      dst.data[d + 3] = a;
    }
  }
}
