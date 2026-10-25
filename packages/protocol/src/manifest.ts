import type { Emotion, Hands } from "./enums";

/**
 * 契约 ③：素材清单（D28）。
 * 只描述「哪个枚举值用哪些贴片文件」，不含渲染逻辑，也不绑定资源目录。
 */
export type FaceLayers = {
  /** 底层主立绘（含中性五官）。 */
  base: string;
  /** 叠加的差分贴片，按从下到上的绘制顺序。 */
  overlays: readonly string[];
};

/** 口型循环：closed 用主立绘的闭嘴，其余用差分贴片。 */
export type MouthShape = "closed" | "small" | "open";

export type CharacterManifest = {
  emotions: Record<Emotion, FaceLayers>;
  hands: Record<Hands, string>;
  /** 眨眼贴片。 */
  blink: string;
  mouth: Record<MouthShape, string | null>;
};
