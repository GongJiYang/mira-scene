import { describe, expect, it } from "vitest";
import type { Media } from "@mira/protocol";
import { initialState, type ClientState } from "../src/state";
import { initialPerformanceState, faceForEmotion } from "../src/state/performance";
import { initialStoryMediaState } from "../src/state/storyMedia";
import { toStageView, type StageViewInput } from "../src/view/useStageViewModel";
import { composeStage } from "../src/stage/layers";

const PHOTO: Media = { type: "photo", id: "photo_letters", storyEventId: "s:1:0" };

/** 集成：视图模型变化 → composeStage 的图层跟着变（架构关卡 §5 测试奖杯）。 */
function layersFor(overrides: Partial<StageViewInput>) {
  const view = toStageView({
    stage: initialState,
    connection: "open",
    sessionId: "s",
    micError: null,
    events: [],
    ...overrides,
  });
  return composeStage({
    phase: view.phase,
    visual: view.visual,
    performance: view.performance,
    storyMedia: view.storyMedia,
    orientation: "portrait",
    develop: 0,
  });
}

const ids = (overrides: Partial<StageViewInput>): string[] => layersFor(overrides).map((layer) => layer.id);

describe("视图模型 → Layer[]", () => {
  it("phase 从 idle 变为 listening 时角色图层加上前倾变换", () => {
    const idle = layersFor({});
    const listeningStage: ClientState = { ...initialState, phase: { kind: "listening" } };
    const listening = layersFor({ stage: listeningStage });

    expect(idle.find((layer) => layer.id === "char:base")?.transform).toBe("none");
    expect(listening.find((layer) => layer.id === "char:base")?.transform).toBe("translateY(-4px) scale(1.02)");
  });

  it("visual.fx 变化 → 背景图层地址变化", () => {
    const main = layersFor({});
    const rainstop = layersFor({
      stage: { ...initialState, visual: { ...initialState.visual, fx: "rain_stop" } },
    });
    expect(main.find((layer) => layer.id === "bg:main")?.src).toContain("b1_bg_main");
    expect(rainstop.find((layer) => layer.id === "bg:main")?.src).toContain("b2_bg_rainstop");
  });

  it("performance 的眨眼/口型/表情透传到图层", () => {
    const layerIds = ids({
      performance: { ...initialPerformanceState, blink: "closed", mouth: "open", face: faceForEmotion("warm") },
    });
    expect(layerIds).toContain("char:blink");
    expect(layerIds).toContain("char:mouth");
    expect(layerIds).toContain("char:face:mouth_smile");
    expect(layerIds).toContain("char:face:blush");
  });

  it("C 状态从 developing 走到 shown → 相纸层换成照片层", () => {
    const developing = ids({ storyMedia: { ...initialStoryMediaState, status: "developing", storyEventId: "s:1:0" } });
    expect(developing).toContain("photo:card");
    expect(developing).not.toContain("photo:image");

    const shown = ids({ storyMedia: { ...initialStoryMediaState, status: "shown", storyEventId: "s:1:0", media: PHOTO } });
    expect(shown).toContain("photo:image");
    expect(shown).not.toContain("photo:card");
  });
});
