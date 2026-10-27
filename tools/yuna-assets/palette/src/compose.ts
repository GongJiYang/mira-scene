/**
 * 像素合成小工具（S6e §2 预览用）。alpha 采用标准 over 混合（非预乘）。
 */
export type Rgba = [number, number, number, number];

/** 把 `top` 叠到 `bottom` 上（sRGB 直通，不做 gamma 校正；预览够用）。 */
export function alphaBlend(bottom: Rgba, top: Rgba): Rgba {
  const [br, bg, bb, ba] = bottom;
  const [tr, tg, tb, ta] = top;
  const taN = ta / 255;
  const outA = taN + (ba / 255) * (1 - taN);
  if (outA === 0) return [0, 0, 0, 0];
  const mix = (c1: number, c2: number): number =>
    Math.round((c2 * taN + c1 * (ba / 255) * (1 - taN)) / outA);
  return [mix(br, tr), mix(bg, tg), mix(bb, tb), Math.round(outA * 255)];
}
