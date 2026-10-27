import { describe, expect, it } from "vitest";
import type { Fx, Media } from "@mira/protocol";
import { faceForEmotion, type StagePhaseKind } from "../src/state/performance";
import type { StoryMediaStatus } from "../src/state/storyMedia";
import {
  backgroundForKey,
  composeStage,
  orientationFor,
  type Orientation,
  type StageLayer,
  type StageVm,
} from "../src/stage/layers";

const PHOTO: Media = { type: "photo", id: "photo_letters", storyEventId: "s:1:0" };

function vm(overrides: Partial<StageVm> = {}): StageVm {
  return {
    phase: "idle",
    visual: { emotion: "neutral", hands: "cup", action: null, camera: null, fx: null },
    performance: {
      face: faceForEmotion("neutral"),
      blink: "open",
      mouth: "closed",
      hands: "cup",
      handsTransition: null,
    },
    storyMedia: { status: "none", media: null },
    orientation: "portrait",
    develop: 0,
    ...overrides,
  };
}

const ids = (layers: StageLayer[]): string[] => layers.map((layer) => layer.id);
const find = (layers: StageLayer[], id: string): StageLayer | undefined => layers.find((layer) => layer.id === id);

describe("orientationFor（§1）", () => {
  it("高 ≥ 宽为竖屏，否则横屏", () => {
    expect(orientationFor(390, 844)).toBe("portrait");
    expect(orientationFor(844, 390)).toBe("landscape");
    expect(orientationFor(500, 500)).toBe("portrait");
  });
});

describe("backgroundForKey（§3）", () => {
  it("fx → 背景三态", () => {
    expect(backgroundForKey(null)).toBe("main");
    expect(backgroundForKey("rain_heavy")).toBe("main");
    expect(backgroundForKey("rain_stop")).toBe("rainstop");
    expect(backgroundForKey("lights_dim")).toBe("closing");
    expect(backgroundForKey("warm_glow")).toBe("closing");
  });
});

describe("composeStage：背景层", () => {
  it.each([
    ["rain_heavy", "b1_bg_main"],
    ["rain_stop", "b2_bg_rainstop"],
    ["lights_dim", "b3_bg_closing"],
    [null, "b1_bg_main"],
  ] as Array<[Fx | null, string]>)("%s → %s", (fx, file) => {
    const layers = composeStage(vm({ visual: { ...vm().visual, fx } }));
    expect(find(layers, "bg:main")?.src).toBe(`/stage/assets/raw/${file}_v.png`);
  });

  it("横屏用 _h 素材（§1）", () => {
    const layers = composeStage(vm({ orientation: "landscape" }));
    expect(find(layers, "bg:main")?.src).toBe("/stage/assets/raw/b1_bg_main_h.png");
  });

  it("warm_glow 叠加一层透明度 0.25 的暖光（§3）", () => {
    const glow = find(composeStage(vm({ visual: { ...vm().visual, fx: "warm_glow" } })), "fx:glow");
    expect(glow).toBeDefined();
    expect(glow?.opacity).toBe(0.25);
    expect(find(composeStage(vm()), "fx:glow")).toBeUndefined();
  });
});

describe("composeStage：角色分层（D24）", () => {
  it("中性：只有 master 底图 + hands，无表情贴片", () => {
    const layers = composeStage(vm());
    expect(ids(layers)).toContain("char:base");
    expect(find(layers, "char:base")?.src).toBe("/stage/assets/parts/master_clean.png");
    expect(ids(layers)).toContain("char:hands");
    expect(ids(layers).some((id) => id.startsWith("char:face:"))).toBe(false);
  });

  it("emotion 决定表情贴片（按 manifest）", () => {
    const layers = composeStage(vm({ performance: { ...vm().performance, face: faceForEmotion("sad") } }));
    expect(ids(layers)).toContain("char:face:brow_sad");
    expect(ids(layers)).toContain("char:face:mouth_sad");
    expect(find(layers, "char:face:brow_sad")?.src).toBe("/stage/assets/parts/brow_sad.png");
  });

  it("眨眼与口型：open/closed 不出层，half/小开口出贴片", () => {
    expect(ids(composeStage(vm())).includes("char:blink")).toBe(false);
    expect(ids(composeStage(vm())).includes("char:mouth")).toBe(false);

    const blinkHalf = composeStage(vm({ performance: { ...vm().performance, blink: "half" } }));
    expect(find(blinkHalf, "char:blink")?.src).toBe("/stage/assets/parts/eyelid_half.png");

    const blinkClosed = composeStage(vm({ performance: { ...vm().performance, blink: "closed" } }));
    expect(find(blinkClosed, "char:blink")?.src).toBe("/stage/assets/parts/eyelid_closed.png");

    const mouthOpen = composeStage(vm({ performance: { ...vm().performance, mouth: "open" } }));
    expect(find(mouthOpen, "char:mouth")?.src).toBe("/stage/assets/parts/mouth_open.png");
  });

  it("手部过渡：出现 from/to 两层并交叉淡化", () => {
    const layers = composeStage(
      vm({
        performance: {
          ...vm().performance,
          hands: "cup",
          handsTransition: { from: "cup", to: "polaroid", progress: 0.25 },
        },
      }),
    );
    const from = find(layers, "char:hands:cup");
    const to = find(layers, "char:hands:polaroid");
    expect(from?.opacity).toBeCloseTo(0.75);
    expect(to?.opacity).toBeCloseTo(0.25);
    expect(ids(layers)).not.toContain("char:hands");
  });

  it("过渡完成后只剩目标图层", () => {
    const layers = composeStage(
      vm({
        performance: {
          ...vm().performance,
          hands: "polaroid",
          handsTransition: { from: "cup", to: "polaroid", progress: 1 },
        },
      }),
    );
    expect(find(layers, "char:hands")?.src).toBe("/stage/assets/parts/arm_polaroid.png");
  });

  it("listening 时角色整体前倾；其它 phase 不变换", () => {
    const listening = composeStage(vm({ phase: "listening" }));
    expect(find(listening, "char:base")?.transform).toBe("translateY(-4px) scale(1.02)");
    expect(find(listening, "char:hands")?.transform).toBe("translateY(-4px) scale(1.02)");

    for (const phase of ["idle", "thinking", "speaking", "error"] as StagePhaseKind[]) {
      expect(find(composeStage(vm({ phase })), "char:base")?.transform).toBe("none");
    }
  });
});

describe("composeStage：前景与拍立得", () => {
  it("前景桌面：竖屏用 parts，横屏用 raw", () => {
    expect(find(composeStage(vm()), "fg:table")?.src).toBe("/stage/assets/parts/fg_table_v.png");
    expect(find(composeStage(vm({ orientation: "landscape" })), "fg:table")?.src).toBe(
      "/stage/assets/raw/b4_fg_table_h.png",
    );
  });

  it("developing / ready → 空白相纸；shown → 图片按显影进度渐显", () => {
    for (const status of ["developing", "ready"] as StoryMediaStatus[]) {
      const layers = composeStage(vm({ storyMedia: { status, media: null } }));
      expect(find(layers, "photo:card")?.src).toBe("");
      expect(find(layers, "photo:image")).toBeUndefined();
    }

    const shown = composeStage(vm({ storyMedia: { status: "shown", media: PHOTO }, develop: 0.5 }));
    expect(find(shown, "photo:image")?.opacity).toBe(0.5);
    expect(find(shown, "photo:image")?.src).toBe("/stage/photos/photo_letters.png");
    expect(find(shown, "photo:card")).toBeUndefined();
  });

  it("none / fallback → 无照片层", () => {
    expect(find(composeStage(vm({ storyMedia: { status: "none", media: null } })), "photo:image")).toBeUndefined();
    expect(find(composeStage(vm({ storyMedia: { status: "fallback", media: PHOTO } })), "photo:image")).toBeUndefined();
  });
});

describe("composeStage：不变量", () => {
  it("每个 phase × fx 组合都有唯一 bg 与唯一 char:base，且 z 单调不减", () => {
    const phases: StagePhaseKind[] = ["idle", "listening", "thinking", "speaking", "error"];
    const fxs: Array<Fx | null> = [null, "rain_heavy", "rain_stop", "lights_dim", "warm_glow"];
    const orientations: Orientation[] = ["portrait", "landscape"];

    for (const phase of phases) {
      for (const fx of fxs) {
        for (const orientation of orientations) {
          const layers = composeStage(vm({ phase, orientation, visual: { ...vm().visual, fx } }));
          expect(layers.filter((layer) => layer.id === "bg:main")).toHaveLength(1);
          expect(layers.filter((layer) => layer.id === "char:base")).toHaveLength(1);
          expect(find(layers, "bg:main")?.src).toContain(backgroundForKey(fx));
          const zs = layers.map((layer) => layer.z);
          expect([...zs].sort((a, b) => a - b)).toEqual(zs);
        }
      }
    }
  });

  it("blink / mouth 覆盖层总是排在底图之上", () => {
    const layers = composeStage(
      vm({ performance: { ...vm().performance, blink: "closed", mouth: "small" } }),
    );
    const base = find(layers, "char:base");
    const blink = find(layers, "char:blink");
    const mouth = find(layers, "char:mouth");
    expect(blink?.z).toBeGreaterThan(base?.z ?? 0);
    expect(mouth?.z).toBeGreaterThan(base?.z ?? 0);
  });
});
