import { describe, expect, it } from "vitest";
import type { Action, Emotion, Hands } from "@mira/protocol";
import {
  BLINK_FRAME_MS,
  HANDS_TRANSITION_MS,
  IDLE_ACTION_AFTER_MS,
  THINKING_SIP_AFTER_MS,
  ERROR_FACE,
  THINKING_FACE,
  CAMERA_FACE,
  faceForEmotion,
  initialPerformanceState,
  performanceReducer,
  type PerformanceAction,
  type PerformanceState,
} from "../src/state/performance";

const run = (state: PerformanceState, ...actions: PerformanceAction[]): PerformanceState =>
  actions.reduce(performanceReducer, state);

const speaking = (at: number): PerformanceState =>
  run(initialPerformanceState, { type: "PHASE", phase: "speaking", at });

const beatLook = (overrides: { emotion?: Emotion; hands?: Hands; action?: Action | null }) => ({
  emotion: overrides.emotion ?? ("warm" as const),
  hands: overrides.hands ?? ("cup" as const),
  action: overrides.action ?? null,
});

describe("B：idle", () => {
  it("进入 idle 记录 idleSince，面部中性、嘴闭合", () => {
    const state = run(initialPerformanceState, { type: "PHASE", phase: "idle", at: 1_000 });
    expect(state.idleSince).toBe(1_000);
    expect(state.face).toEqual(CAMERA_FACE);
    expect(state.mouth).toBe("closed");
  });

  it("眨眼 open→half→closed→half→open，每帧 60ms", () => {
    let state = run(initialPerformanceState, { type: "PHASE", phase: "idle", at: 0 });
    state = run(state, { type: "BLINK", at: 2_000 });
    expect(state.blink).toBe("half");

    state = performanceReducer(state, { type: "TICK", at: 2_000 + BLINK_FRAME_MS });
    expect(state.blink).toBe("closed");
    state = performanceReducer(state, { type: "TICK", at: 2_000 + BLINK_FRAME_MS * 2 });
    expect(state.blink).toBe("half");
    state = performanceReducer(state, { type: "TICK", at: 2_000 + BLINK_FRAME_MS * 3 });
    expect(state.blink).toBe("open");
    expect(state.blinkFrameAt).toBeNull();
  });

  it("未到 60ms 不推进眨眼帧", () => {
    let state = run(initialPerformanceState, { type: "PHASE", phase: "idle", at: 0 });
    state = run(state, { type: "BLINK", at: 2_000 }, { type: "TICK", at: 2_000 + BLINK_FRAME_MS - 1 });
    expect(state.blink).toBe("half");
  });

  it("待机小动作只执行一次，并把 hands 切到动作对应的图层", () => {
    let state = run(initialPerformanceState, { type: "PHASE", phase: "idle", at: 0 });
    state = run(state, { type: "IDLE_ACTION", action: "phone", at: 8_000 });
    expect(state.activeAction).toEqual({ action: "phone", startedAt: 8_000 });
    expect(state.hands).toBe("phone");
    expect(state.idleActionDone).toBe(true);

    const second = performanceReducer(state, { type: "IDLE_ACTION", action: "drink", at: 9_000 });
    expect(second).toBe(state);
  });

  it("glance 不改手部", () => {
    let state = run(initialPerformanceState, { type: "PHASE", phase: "idle", at: 0 });
    state = run(state, { type: "IDLE_ACTION", action: "glance", at: 8_000 });
    expect(state.hands).toBe("cup");
  });

  it("非 idle 时眨眼事件被忽略", () => {
    const state = speaking(0);
    expect(performanceReducer(state, { type: "BLINK", at: 100 })).toBe(state);
  });
});

describe("B：listening", () => {
  it("面部立即切到看镜头、嘴闭合、清空动作", () => {
    let state = run(speaking(0), {
      type: "BEAT_STARTED",
      look: beatLook({ emotion: "surprised", action: "show_item" }),
      at: 100,
    });
    expect(state.face).toEqual(faceForEmotion("surprised"));

    state = performanceReducer(state, { type: "PHASE", phase: "listening", at: 150 });
    expect(state.phase).toBe("listening");
    expect(state.face).toEqual(CAMERA_FACE);
    expect(state.mouth).toBe("closed");
    expect(state.activeAction).toBeNull();
  });

  it("手部 200ms 平滑收回 cup：进度随 TICK 推进，完成后落位", () => {
    let state = run(speaking(0), {
      type: "BEAT_STARTED",
      look: beatLook({ hands: "phone", action: "phone" }),
      at: 0,
    });
    // 先让 phone 的过渡完成，hand 真正落在 phone。
    state = performanceReducer(state, { type: "TICK", at: HANDS_TRANSITION_MS });
    expect(state.hands).toBe("phone");

    state = performanceReducer(state, { type: "PHASE", phase: "listening", at: 300 });
    expect(state.handsTransition).toEqual({ from: "phone", to: "cup", startedAt: 300, progress: 0 });
    expect(state.hands).toBe("phone");

    state = performanceReducer(state, { type: "TICK", at: 300 + HANDS_TRANSITION_MS / 2 });
    expect(state.handsTransition?.progress).toBeCloseTo(0.5);
    expect(state.hands).toBe("phone");

    state = performanceReducer(state, { type: "TICK", at: 300 + HANDS_TRANSITION_MS });
    expect(state.hands).toBe("cup");
    expect(state.handsTransition).toBeNull();
  });

  it("手部已在 cup 时打断：不产生多余过渡", () => {
    const state = run(speaking(0), { type: "PHASE", phase: "listening", at: 10 });
    expect(state.hands).toBe("cup");
    expect(state.handsTransition).toBeNull();
  });
});

describe("B：thinking", () => {
  it("使用 eyelid_half，嘴闭合", () => {
    const state = run(initialPerformanceState, { type: "PHASE", phase: "thinking", at: 0 });
    expect(state.face).toEqual(THINKING_FACE);
    expect(state.face.overlays).toEqual(["eyelid_half"]);
    expect(state.mouth).toBe("closed");
  });

  it("持续超过 2s 补一次 drink，只补一次", () => {
    let state = run(initialPerformanceState, { type: "PHASE", phase: "thinking", at: 1_000 });
    state = performanceReducer(state, { type: "TICK", at: 1_000 + THINKING_SIP_AFTER_MS - 1 });
    expect(state.activeAction).toBeNull();

    state = performanceReducer(state, { type: "TICK", at: 1_000 + THINKING_SIP_AFTER_MS });
    expect(state.activeAction).toEqual({ action: "drink", startedAt: 3_000 });
    expect(state.hands).toBe("cup");

    const later = performanceReducer(state, { type: "TICK", at: 9_000 });
    expect(later.activeAction).toEqual({ action: "drink", startedAt: 3_000 });
  });

  it("重新进入 thinking 时重置 sip 标记", () => {
    let state = run(initialPerformanceState, { type: "PHASE", phase: "thinking", at: 0 });
    state = performanceReducer(state, { type: "TICK", at: THINKING_SIP_AFTER_MS });
    expect(state.thinkingSipDone).toBe(true);

    state = performanceReducer(state, { type: "PHASE", phase: "idle", at: 5_000 });
    state = performanceReducer(state, { type: "PHASE", phase: "thinking", at: 6_000 });
    expect(state.thinkingSipDone).toBe(false);
  });
});

describe("B：speaking", () => {
  it("表情跟随 beat.emotion，手部跟随 beat.hands", () => {
    const state = run(speaking(0), {
      type: "BEAT_STARTED",
      look: beatLook({ emotion: "sad", hands: "polaroid" }),
      at: 0,
    });
    expect(state.face).toEqual(faceForEmotion("sad"));
    expect(state.handsTransition).toEqual({ from: "cup", to: "polaroid", startedAt: 0, progress: 0 });

    const done = performanceReducer(state, { type: "TICK", at: HANDS_TRANSITION_MS });
    expect(done.hands).toBe("polaroid");
  });

  it("beat.action 决定手部与 activeAction", () => {
    const state = run(speaking(0), {
      type: "BEAT_STARTED",
      look: beatLook({ hands: "cup", action: "show_item" }),
      at: 500,
    });
    expect(state.activeAction).toEqual({ action: "show_item", startedAt: 500 });
    expect(state.handsTransition?.to).toBe("polaroid");
  });

  it("speaking 时口型跟随音量；音频停止的那一帧变为 closed", () => {
    let state = speaking(0);
    state = performanceReducer(state, { type: "MOUTH", shape: "open", audioPlaying: true });
    expect(state.mouth).toBe("open");

    state = performanceReducer(state, { type: "MOUTH", shape: "small", audioPlaying: true });
    expect(state.mouth).toBe("small");

    // 音频停止：同一帧回到 closed（mouthFor 的门槛）。
    state = performanceReducer(state, { type: "MOUTH", shape: "open", audioPlaying: false });
    expect(state.mouth).toBe("closed");
  });

  it("非 speaking 时口型一律 closed（忽略传入的音量形状）", () => {
    const idle = run(initialPerformanceState, { type: "PHASE", phase: "idle", at: 0 });
    expect(performanceReducer(idle, { type: "MOUTH", shape: "open", audioPlaying: true })).toBe(idle);
  });

  it("beat 只在 speaking 时生效", () => {
    const thinking = run(initialPerformanceState, { type: "PHASE", phase: "thinking", at: 0 });
    expect(
      performanceReducer(thinking, { type: "BEAT_STARTED", look: beatLook({ emotion: "sad" }), at: 1 }),
    ).toBe(thinking);
  });
});

describe("B：error", () => {
  it("使用 brow_raised，手部 cup", () => {
    const state = run(speaking(0), { type: "PHASE", phase: "error", at: 0 });
    expect(state.face).toEqual(ERROR_FACE);
    expect(state.face.overlays).toEqual(["brow_raised"]);
    expect(state.hands).toBe("cup");
    expect(state.mouth).toBe("closed");
  });
});

describe("B：不变量", () => {
  it("同一 phase 重复到达不重置 idleSince / 状态", () => {
    const state = run(initialPerformanceState, { type: "PHASE", phase: "idle", at: 1_000 });
    expect(performanceReducer(state, { type: "PHASE", phase: "idle", at: 9_000 })).toBe(state);
  });

  it("待机小动作的阈值与 D28 常量一致", () => {
    expect(IDLE_ACTION_AFTER_MS).toBe(8_000);
    expect(THINKING_SIP_AFTER_MS).toBe(2_000);
  });
});
