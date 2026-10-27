import { describe, expect, it } from "vitest";
import type { Media } from "@mira/protocol";
import {
  initialStoryMediaState,
  storyMediaReducer,
  type StoryMediaAction,
  type StoryMediaState,
} from "../src/state/storyMedia";

const PHOTO: Media = { type: "photo", id: "photo_letters" };
const LETTER_REVEAL: Media = { type: "video", id: "letter_reveal" };

const run = (state: StoryMediaState, ...actions: StoryMediaAction[]): StoryMediaState =>
  actions.reduce(storyMediaReducer, state);

const requested = (storyEventId = "story-1"): StoryMediaState =>
  storyMediaReducer(initialStoryMediaState, { type: "REQUEST", storyEventId, kind: "photo" });

describe("C：显影生命周期", () => {
  it("REQUEST：none → developing，不绑定轮次", () => {
    const state = requested();
    expect(state.status).toBe("developing");
    expect(state.storyEventId).toBe("story-1");
    expect(state.media).toBeNull();
    expect(state.processed["story-1"]).toBe("developing");
  });

  it("ready 先于 speaking 结束：排队，回到可展示状态才 shown", () => {
    let state = run(requested(), { type: "PHASE", phase: "speaking" });
    state = storyMediaReducer(state, { type: "READY", storyEventId: "story-1", media: PHOTO });
    expect(state.status).toBe("ready");
    expect(state.media).toEqual(PHOTO);

    state = storyMediaReducer(state, { type: "PHASE", phase: "idle" });
    expect(state.status).toBe("shown");
  });

  it("ready 晚于 speaking 结束（A 已 idle）：立即 shown", () => {
    let state = run(requested(), { type: "PHASE", phase: "idle" });
    state = storyMediaReducer(state, { type: "READY", storyEventId: "story-1", media: PHOTO });
    expect(state.status).toBe("shown");
    expect(state.media).toEqual(PHOTO);
    expect(state.processed["story-1"]).toBe("shown");
  });

  it("ready 到达时 A 在 listening：排队到下一次 idle", () => {
    let state = run(requested(), { type: "PHASE", phase: "listening" });
    state = storyMediaReducer(state, { type: "READY", storyEventId: "story-1", media: PHOTO });
    expect(state.status).toBe("ready");

    state = storyMediaReducer(state, { type: "PHASE", phase: "thinking" });
    state = storyMediaReducer(state, { type: "PHASE", phase: "speaking" });
    state = storyMediaReducer(state, { type: "PHASE", phase: "idle" });
    expect(state.status).toBe("shown");
  });

  it("显影中被打断（A 进入 listening / 新一轮）：不作废", () => {
    let state = run(requested(), { type: "PHASE", phase: "speaking" });
    state = run(
      state,
      { type: "PHASE", phase: "listening" },
      { type: "PHASE", phase: "thinking" },
      { type: "PHASE", phase: "speaking" },
    );
    expect(state.status).toBe("developing");
    expect(state.storyEventId).toBe("story-1");

    state = storyMediaReducer(state, { type: "READY", storyEventId: "story-1", media: PHOTO });
    expect(state.status).toBe("ready");
    state = storyMediaReducer(state, { type: "PHASE", phase: "idle" });
    expect(state.status).toBe("shown");
  });

  it("失败 → fallback → shown", () => {
    let state = run(requested(), { type: "PHASE", phase: "speaking" });
    state = storyMediaReducer(state, { type: "FALLBACK", storyEventId: "story-1", media: LETTER_REVEAL });
    expect(state.status).toBe("fallback");
    expect(state.media).toEqual(LETTER_REVEAL);

    state = storyMediaReducer(state, { type: "PHASE", phase: "idle" });
    expect(state.status).toBe("shown");
    expect(state.processed["story-1"]).toBe("shown");
  });

  it("fallback 到达时已 idle：直接 shown", () => {
    const state = storyMediaReducer(initialStoryMediaState, {
      type: "FALLBACK",
      storyEventId: "story-1",
      media: PHOTO,
    });
    expect(state.status).toBe("shown");
  });
});

describe("C：按 storyEventId 去重", () => {
  it("同一 storyEventId 的重复 READY / FALLBACK 一律忽略", () => {
    let state = storyMediaReducer(initialStoryMediaState, { type: "READY", storyEventId: "story-1", media: PHOTO });
    expect(state.status).toBe("shown");

    const duplicateReady = storyMediaReducer(state, {
      type: "READY",
      storyEventId: "story-1",
      media: LETTER_REVEAL,
    });
    expect(duplicateReady).toBe(state);

    const duplicateFallback = storyMediaReducer(state, {
      type: "FALLBACK",
      storyEventId: "story-1",
      media: LETTER_REVEAL,
    });
    expect(duplicateFallback).toBe(state);

    const duplicateRequest = storyMediaReducer(state, { type: "REQUEST", storyEventId: "story-1", kind: "photo" });
    expect(duplicateRequest).toBe(state);
  });

  it("不同的 storyEventId 可以先后展示", () => {
    let state = storyMediaReducer(initialStoryMediaState, { type: "READY", storyEventId: "story-1", media: PHOTO });
    state = storyMediaReducer(state, { type: "REQUEST", storyEventId: "story-2", kind: "photo" });
    expect(state.status).toBe("developing");
    state = storyMediaReducer(state, { type: "READY", storyEventId: "story-2", media: LETTER_REVEAL });
    expect(state.status).toBe("shown");
    expect(state.media).toEqual(LETTER_REVEAL);
  });

  it("另一张还在显影时，新的 READY 不会覆盖当前那张", () => {
    let state = run(requested("story-1"), { type: "PHASE", phase: "speaking" });
    state = storyMediaReducer(state, { type: "READY", storyEventId: "story-2", media: LETTER_REVEAL });
    expect(state.storyEventId).toBe("story-1");
    expect(state.status).toBe("developing");
  });
});

describe("C：phase 镜像", () => {
  it("phase 变化在不影响显示时只更新镜像", () => {
    const state = storyMediaReducer(initialStoryMediaState, { type: "PHASE", phase: "thinking" });
    expect(state.status).toBe("none");
    expect(state.phase).toBe("thinking");
  });

  it("非 speaking/listening 即视为可展示（thinking 也算）", () => {
    let state = storyMediaReducer(initialStoryMediaState, {
      type: "READY",
      storyEventId: "story-1",
      media: PHOTO,
    });
    expect(state.status).toBe("shown");
  });
});
