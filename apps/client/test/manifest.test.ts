import { describe, expect, it } from "vitest";
import { emotionSchema, handsSchema, type MouthShape } from "@mira/protocol";
import { characterManifest } from "../src/render/manifest";

/**
 * 通过 Vite 的资源 glob 证明文件真实存在（客户端 tsconfig 没有 Node 类型）。
 * 键形如 `../../../assets/parts/arm_cup.png`。
 */
const partModules = import.meta.glob("../../../assets/parts/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

const partNames = new Set(
  Object.keys(partModules).map((path) => {
    const file = path.split("/").at(-1) ?? path;
    return file.replace(/\.png$/, "");
  }),
);

const MOUTH_SHAPES: MouthShape[] = ["closed", "small", "open"];

describe("角色素材清单（契约 ③）", () => {
  it("assets/parts 下确实有贴片文件（glob 生效）", () => {
    expect(partNames.size).toBeGreaterThan(0);
  });

  it("每个 Emotion 枚举值都有映射，且映射的贴片文件都存在", () => {
    for (const emotion of emotionSchema.options) {
      const layers = characterManifest.emotions[emotion];
      expect(layers, `Emotion ${emotion} 缺少映射`).toBeDefined();
      expect(partNames.has(layers.base), `${emotion}.base ${layers.base}.png 不存在`).toBe(true);
      for (const overlay of layers.overlays) {
        expect(partNames.has(overlay), `${emotion} 的贴片 ${overlay}.png 不存在`).toBe(true);
      }
    }
  });

  it("每个 Hands 枚举值都有映射，且映射的手部贴片文件都存在", () => {
    for (const hands of handsSchema.options) {
      const part = characterManifest.hands[hands];
      expect(part, `Hands ${hands} 缺少映射`).toBeDefined();
      expect(partNames.has(part), `${hands} 的贴片 ${part}.png 不存在`).toBe(true);
    }
  });

  it("眨眼与口型贴片都存在", () => {
    expect(partNames.has(characterManifest.blink)).toBe(true);
    for (const shape of MOUTH_SHAPES) {
      const part = characterManifest.mouth[shape];
      expect(part, `口型 ${shape} 缺少映射`).toBeDefined();
      if (part !== null) expect(partNames.has(part), `口型 ${shape} 的贴片 ${part}.png 不存在`).toBe(true);
    }
  });

  it("D28 映射：neutral/calm 不叠贴片，guarded/sad/warm/surprised 与决策一致", () => {
    expect(characterManifest.emotions.neutral.overlays).toEqual([]);
    expect(characterManifest.emotions.calm.overlays).toEqual([]);
    expect(characterManifest.emotions.guarded.overlays).toEqual(["eyelid_half"]);
    expect(characterManifest.emotions.sad.overlays).toEqual(["brow_sad", "mouth_sad"]);
    expect(characterManifest.emotions.warm.overlays).toEqual(["mouth_smile", "blush"]);
    expect(characterManifest.emotions.surprised.overlays).toEqual(["brow_raised", "mouth_o"]);
  });

  it("不再引用已废弃的 brow_soft", () => {
    const overlays = emotionSchema.options.flatMap((emotion) => characterManifest.emotions[emotion].overlays);
    expect(overlays).not.toContain("brow_soft");
  });
});
