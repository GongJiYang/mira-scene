import { describe, expect, it } from "vitest";
import { initialState } from "../src/state";
import { initialPerformanceState } from "../src/state/performance";
import { initialStoryMediaState } from "../src/state/storyMedia";
import { toStageView } from "../src/view/useStageViewModel";

const baseInput = {
  stage: initialState,
  connection: "open" as const,
  sessionId: "session-1",
  micError: null,
  events: [],
};

describe("toStageView：G1-c 新增字段", () => {
  it("缺省时用 B / C 的初始状态，pendingNudge=false", () => {
    const view = toStageView(baseInput);
    expect(view.performance).toEqual({
      face: initialPerformanceState.face,
      blink: "open",
      mouth: "closed",
      hands: "cup",
      handsTransition: null,
      activeAction: null,
      idleSince: null,
    });
    expect(view.storyMedia).toEqual({ status: "none", storyEventId: null, media: null });
    expect(view.pendingNudge).toBe(false);
  });

  it("透传 B 的眨眼 / 口型 / 手部过渡与 C 的媒体状态", () => {
    const view = toStageView({
      ...baseInput,
      performance: {
        ...initialPerformanceState,
        blink: "closed",
        mouth: "open",
        hands: "phone",
        handsTransition: { from: "phone", to: "cup", startedAt: 100, progress: 0.5 },
        activeAction: { action: "sip_coffee", startedAt: 200 },
        idleSince: 50,
      },
      storyMedia: {
        ...initialStoryMediaState,
        status: "shown",
        storyEventId: "story-1",
        media: { type: "photo", id: "photo_letters" },
      },
      pendingNudge: true,
    });

    expect(view.performance.blink).toBe("closed");
    expect(view.performance.mouth).toBe("open");
    expect(view.performance.handsTransition).toEqual({ from: "phone", to: "cup", startedAt: 100, progress: 0.5 });
    expect(view.performance.activeAction).toEqual({ action: "sip_coffee", startedAt: 200 });
    expect(view.performance.idleSince).toBe(50);
    expect(view.storyMedia).toEqual({
      status: "shown",
      storyEventId: "story-1",
      media: { type: "photo", id: "photo_letters" },
    });
    expect(view.pendingNudge).toBe(true);
  });

  it("已有字段保持原样", () => {
    const view = toStageView(baseInput);
    expect(view.phase).toBe("idle");
    expect(view.visual).toEqual(initialState.visual);
    expect(view.error).toBeNull();
    expect(view.debug).toEqual({ turnId: 0, sessionId: "session-1", lastEvents: [] });
  });
});
