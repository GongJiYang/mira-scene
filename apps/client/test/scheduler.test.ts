import { describe, expect, it } from "vitest";
import type { Beat } from "@mira/protocol";
import { pickNextPlayable } from "../src/core/scheduler";
import { initialState, type ClientState, type Phase } from "../src/state";

function beat(seq: number, say = `第${seq}句`): Beat {
  return { seq, say, emotion: "neutral", accent: null, hands: "cup", action: null, camera: null, fx: null, media: null, story: null };
}

function view(phase: Phase, queue: Beat[]): ClientState {
  return { ...initialState, phase, queue };
}

describe("pickNextPlayable", () => {
  it("正在播放时返回 null", () => {
    expect(pickNextPlayable(view({ kind: "thinking" }, [beat(0)]), new Set([0]), true)).toBeNull();
  });

  it("没有待播 beat 时返回 null", () => {
    expect(pickNextPlayable(view({ kind: "thinking" }, []), new Set(), false)).toBeNull();
  });

  it("无声 beat 不等音频，直接返回 silent", () => {
    expect(pickNextPlayable(view({ kind: "speaking", seq: 0 }, [beat(2, "")]), new Set(), false)).toEqual({
      seq: 2,
      silent: true,
    });
  });

  it("音频未就绪时返回 null（继续等待）", () => {
    expect(pickNextPlayable(view({ kind: "thinking" }, [beat(0)]), new Set(), false)).toBeNull();
  });

  it("音频已就绪时返回可播放", () => {
    expect(pickNextPlayable(view({ kind: "thinking" }, [beat(0)]), new Set([0]), false)).toEqual({
      seq: 0,
      silent: false,
    });
  });

  it("phase 为 idle 或 listening 时不播放", () => {
    expect(pickNextPlayable(view({ kind: "idle" }, [beat(0)]), new Set([0]), false)).toBeNull();
    expect(pickNextPlayable(view({ kind: "listening" }, [beat(0)]), new Set([0]), false)).toBeNull();
    expect(pickNextPlayable(view({ kind: "error", code: "x", message: "y", retryable: false }, [beat(0)]), new Set([0]), false)).toBeNull();
  });

  it("乱序就绪：seq1 先就绪而 seq0 未就绪 → null；seq0 就绪后 → seq0", () => {
    const state = view({ kind: "speaking", seq: 1 }, [beat(0), beat(1)]);
    expect(pickNextPlayable(state, new Set([1]), false)).toBeNull();
    expect(pickNextPlayable(state, new Set([0, 1]), false)).toEqual({ seq: 0, silent: false });
  });

  it("freeze-fix5 §2.2：本轮 TTS 降级 → 未就绪的 beat 也按无声处理（不卡死）", () => {
    const degraded: ClientState = { ...view({ kind: "speaking", seq: 0 }, [beat(1)]), currentTurnId: 1, ttsDegradedTurnId: 1 };
    expect(pickNextPlayable(degraded, new Set(), false)).toEqual({ seq: 1, silent: true });
    // 音频就绪时仍走正常路径（优先真实音频）。
    expect(pickNextPlayable(degraded, new Set([1]), false)).toEqual({ seq: 1, silent: false });
  });

  it("freeze-fix5 §2.2：迟到的旧轮降级标记不影响当前轮（只比对 currentTurnId）", () => {
    const state: ClientState = { ...view({ kind: "thinking" }, [beat(0)]), currentTurnId: 2, ttsDegradedTurnId: 1 };
    expect(pickNextPlayable(state, new Set(), false)).toBeNull();
  });
});
