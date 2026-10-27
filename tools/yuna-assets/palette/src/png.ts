/**
 * 最小 PNG 编解码（S6e §1/§2）。
 *
 * 忧奈贴图只有一种形态：8bit / RGBA（color type 6）/ 不隔行。这里只实现这一种，
 * 遇到别的形态直接抛错，不做通用 PNG 库（YAGNI）。
 *
 * 纯 I/O 工具：只依赖 Node 的 `zlib`，不依赖 Cubism、不做决策。
 */
import { deflateSync, inflateSync } from "node:zlib";

/** 解码出来的 RGBA 位图：`data` 长度 = width * height * 4（行优先，不含 padding）。 */
export type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** CRC32 查表（PNG 每块结尾的校验）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 把贴图字节解码成 RGBA 位图；只接受 8bit RGBA、不隔行。 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("不是 PNG 文件（签名不符）");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idatChunks: Uint8Array[] = [];

  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    const dataStart = offset + 8;
    if (type === "IHDR") {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8]!;
      const colorType = bytes[dataStart + 9]!;
      const interlace = bytes[dataStart + 12]!;
      if (bitDepth !== 8) throw new Error(`不支持的位深：${bitDepth}（只支持 8bit）`);
      if (colorType !== 6) throw new Error(`不支持的颜色类型：${colorType}（只支持 RGBA）`);
      if (interlace !== 0) throw new Error("不支持隔行 PNG");
    } else if (type === "IDAT") {
      idatChunks.push(bytes.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4;
  }

  if (width <= 0 || height <= 0) throw new Error("PNG 缺少 IHDR 或尺寸非法");

  const raw = inflateSync(concat(idatChunks));
  const bpp = 4;
  const stride = width * bpp;
  const expected = (stride + 1) * height;
  if (raw.length !== expected) {
    throw new Error(`IDAT 解压后长度不符：期望 ${expected}，实际 ${raw.length}`);
  }

  const data = new Uint8Array(stride * height);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src]!;
    src += 1;
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[src + x]!;
      const left = x >= bpp ? data[rowStart + x - bpp]! : 0;
      const up = y > 0 ? data[prevRowStart + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? data[prevRowStart + x - bpp]! : 0;
      data[rowStart + x] = unfilter(filter, rawByte, left, up, upLeft);
    }
    src += stride;
  }

  return { width, height, data };
}

function unfilter(filter: number, raw: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return raw;
    case 1:
      return (raw + left) & 0xff;
    case 2:
      return (raw + up) & 0xff;
    case 3:
      return (raw + ((left + up) >> 1)) & 0xff;
    case 4: {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      return (raw + predictor) & 0xff;
    }
    default:
      throw new Error(`未知 PNG 滤波器：${filter}`);
  }
}

/** 把 RGBA 位图编码成 PNG（8bit RGBA，filter 0）。 */
export function encodePng(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  const stride = width * 4;
  if (data.length !== stride * height) {
    throw new Error(`位图数据长度不符：期望 ${stride * height}，实际 ${data.length}`);
  }

  const rows = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (stride + 1)] = 0;
    rows.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(rows, { level: 9 });

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const chunks = [
    Uint8Array.from(PNG_SIGNATURE),
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", idat),
    makeChunk("IEND", new Uint8Array(0)),
  ];
  return concat(chunks);
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  const crcInput = chunk.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return chunk;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
