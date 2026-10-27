import { describe, expect, it } from "vitest";
import type { Media } from "@mira/protocol";
import {
  initialStoryMediaState,
  storyMediaReducer,
  type StoryMediaAction,
  type StoryMediaState,
} from "../src/state/storyMedia";

const PHOTO: Media = { type: "photo", id: "old_stream_shot", storyEventId: "s:3:1" };
const VIDEO: Media = { type: "video", id: "clip_offline", storyEventId: "s:5:1" };

const run = (state: StoryMediaState, ...actions: StoryMediaAction[]): StoryMediaState =>
  actions.reduce(storyMediaReducer, state);

describe("S5-fix ①：ending 视频在 media_ready 前不显示空白相纸", () => {
  it("视频 REQUEST 不把照片槽位推进到 developing（不会出现 photo:card）", () => {
    const state = storyMediaReducer(initialStoryMediaState, {
      type: "REQUEST",
      storyEventId: "s:5:1",
      kind: "video",
    });
    // 照片槽位保持 none（外壳的空白相纸只由照片槽位的 developing/ready 触发）。
    expect(state.status).toBe("none");
    expect(state.media).toBeNull();
    // 视频槽位进入 developing（外壳据此知道视频正在准备）。
    expect(state.video.status).toBe("developing");
    expect(state.video.storyEventId).toBe("s:5:1");
  });

  it("视频 READY 到 shown：视频槽位就绪，照片槽位仍为空", () => {
    let state = storyMediaReducer(initialStoryMediaState, {
      type: "REQUEST",
      storyEventId: "s:5:1",
      kind: "video",
    });
    state = storyMediaReducer(state, { type: "READY", storyEventId: "s:5:1", media: VIDEO });
    expect(state.video.status).toBe("shown");
    expect(state.video.media).toEqual(VIDEO);
    expect(state.status).toBe("none");
    expect(state.media).toBeNull();
  });

  it("视频 READY 到达时 A 在 speaking：视频排队，照片槽位不受影响", () => {
    let state = run(initialStoryMediaState, { type: "PHASE", phase: "speaking" });
    state = storyMediaReducer(state, { type: "REQUEST", storyEventId: "s:5:1", kind: "video" });
    state = storyMediaReducer(state, { type: "READY", storyEventId: "s:5:1", media: VIDEO });
    expect(state.video.status).toBe("ready");
    expect(state.status).toBe("none");

    state = storyMediaReducer(state, { type: "PHASE", phase: "idle" });
    expect(state.video.status).toBe("shown");
  });
});

describe("S5-fix ②：reveal 的照片保留，视频不占照片槽位", () => {
  /** 先走到 reveal 照片 shown。 */
  function revealedPhoto(): StoryMediaState {
    let state = storyMediaReducer(initialStoryMediaState, {
      type: "REQUEST",
      storyEventId: "s:3:1",
      kind: "photo",
    });
    state = storyMediaReducer(state, { type: "READY", storyEventId: "s:3:1", media: PHOTO });
    return state;
  }

  it("照片 shown 后，视频 REQUEST/READY 不改动照片槽位", () => {
    let state = revealedPhoto();
    expect(state.status).toBe("shown");
    expect(state.media).toEqual(PHOTO);

    state = storyMediaReducer(state, { type: "REQUEST", storyEventId: "s:5:1", kind: "video" });
    // 照片槽位保持 shown（reveal 的照片不消失）。
    expect(state.status).toBe("shown");
    expect(state.media).toEqual(PHOTO);

    state = storyMediaReducer(state, { type: "READY", storyEventId: "s:5:1", media: VIDEO });
    expect(state.status).toBe("shown");
    expect(state.media).toEqual(PHOTO);
    expect(state.video.status).toBe("shown");
    expect(state.video.media).toEqual(VIDEO);
  });

  it("视频结束（dismissed，由 videoReducer 管）后照片槽位仍在", () => {
    let state = revealedPhoto();
    state = run(
      state,
      { type: "REQUEST", storyEventId: "s:5:1", kind: "video" },
      { type: "READY", storyEventId: "s:5:1", media: VIDEO },
      // 打断：A 换轮 → 照片槽位不因轮次作废（D27），视频置 dismissed 在 videoReducer。
      { type: "PHASE", phase: "listening" },
    );
    expect(state.status).toBe("shown");
    expect(state.media).toEqual(PHOTO);
    // 视频槽位本身不因 phase 变化消失（结束由 videoReducer 的 TURN 处理）。
    expect(state.video.status).toBe("shown");
  });

  it("照片与视频各自的 storyEventId 与 kind 都记在表里", () => {
    let state = revealedPhoto();
    state = run(
      state,
      { type: "REQUEST", storyEventId: "s:5:1", kind: "video" },
      { type: "READY", storyEventId: "s:5:1", media: VIDEO },
    );
    expect(state.kinds["s:3:1"]).toBe("photo");
    expect(state.kinds["s:5:1"]).toBe("video");
    expect(state.storyEventId).toBe("s:3:1");
    expect(state.video.storyEventId).toBe("s:5:1");
  });
});
