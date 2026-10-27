import { describe, expect, it } from "vitest";
import { toStageView } from "../src/view/useStageViewModel";
import { initialState, type ClientState, type Phase } from "../src/state";

function viewOf(stage: ClientState) {
  return toStageView({ stage, connection: "open", sessionId: "session-1", micError: null, events: ["e1", "e2"] });
}

function stageWith(phase: Phase): ClientState {
  return { ...initialState, phase };
}

function richState(): ClientState {
  return {
    ...initialState,
    currentTurnId: 4,
    subtitle: "信到了，人没来。",
    visual: { emotion: "sad", hands: "phone", action: "phone", camera: "close_up", fx: "rain_stop" },
    media: { type: "video", id: "letter_reveal" },
  };
}

describe("toStageView：phase 映射", () => {
  it.each([
    ["idle", { kind: "idle" }],
    ["listening", { kind: "listening" }],
    ["thinking", { kind: "thinking" }],
    ["speaking", { kind: "speaking", seq: 2 }],
    ["error", { kind: "error", code: "turn_failed", message: "boom", retryable: true }],
  ] as Array<[string, Phase]>)("%s", (expected, phase) => {
    expect(viewOf(stageWith(phase)).phase).toBe(expected);
  });

  it("error 只从 error phase 暴露，其余为 null", () => {
    expect(viewOf(stageWith({ kind: "idle" })).error).toBeNull();
    expect(viewOf(stageWith({ kind: "error", code: "turn_failed", message: "boom", retryable: true })).error).toEqual({
      code: "turn_failed",
      message: "boom",
      retryable: true,
    });
  });
});

describe("toStageView：其余字段透传", () => {
  it("visual / subtitle / media / connection / micError / debug", () => {
    const stage = richState();
    const view = toStageView({
      stage,
      connection: "reconnecting",
      sessionId: null,
      micError: "权限被拒绝",
      events: ["a", "b"],
    });

    expect(view.visual).toEqual(stage.visual);
    expect(view.subtitle).toBe("信到了，人没来。");
    expect(view.media).toEqual({ type: "video", id: "letter_reveal" });
    expect(view.connection).toBe("reconnecting");
    expect(view.micError).toBe("权限被拒绝");
    expect(view.debug).toEqual({ turnId: 4, sessionId: null, lastEvents: ["a", "b"] });
  });
});
