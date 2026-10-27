import { describe, expect, it } from "vitest";
import type { Media } from "@mira/protocol";
import { initialStoryMediaState, storyMediaReducer, type StoryMediaState } from "../src/state/storyMedia";

const PHOTO: Media = { type: "photo", id: "photo_letters", storyEventId: "s:1:0" };
const FALLBACK: Media = { type: "photo", id: "photo_rain_street", storyEventId: "s:1:0" };

/** 走到 shown（ready 到达时 A 已经 idle）。 */
function shown(): StoryMediaState {
  let state = storyMediaReducer(initialStoryMediaState, { type: "REQUEST", storyEventId: "s:1:0", kind: "photo" });
  state = storyMediaReducer(state, { type: "READY", storyEventId: "s:1:0", media: PHOTO });
  return state;
}

describe("C：图片加载失败 → 换另一张预置照片（Q8）", () => {
  it("shown 时失败：媒体换成预置照片，状态保持 shown，显影继续", () => {
    const next = storyMediaReducer(shown(), { type: "IMAGE_FAILED", storyEventId: "s:1:0", media: FALLBACK });
    expect(next.status).toBe("shown");
    expect(next.media).toEqual(FALLBACK);
    expect(next.processed["s:1:0"]).toBe("fallback");
  });

  it("不匹配的 storyEventId 不影响当前这张", () => {
    const state = shown();
    expect(storyMediaReducer(state, { type: "IMAGE_FAILED", storyEventId: "other", media: FALLBACK })).toBe(state);
  });

  it("不在 shown 时不处理（还没上桌）", () => {
    const requested = storyMediaReducer(initialStoryMediaState, { type: "REQUEST", storyEventId: "s:1:0", kind: "photo" });
    expect(storyMediaReducer(requested, { type: "IMAGE_FAILED", storyEventId: "s:1:0", media: FALLBACK })).toBe(requested);
  });

  it("失败后再收到同一个 storyEventId 的 READY 不会覆盖（已被标记 fallback）", () => {
    const failed = storyMediaReducer(shown(), { type: "IMAGE_FAILED", storyEventId: "s:1:0", media: FALLBACK });
    const late = storyMediaReducer(failed, { type: "READY", storyEventId: "s:1:0", media: PHOTO });
    expect(late).toBe(failed);
    expect(late.media).toEqual(FALLBACK);
  });
});
