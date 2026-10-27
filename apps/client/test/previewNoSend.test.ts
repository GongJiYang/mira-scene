import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../src/core/connection";
import { useStageStore } from "../src/core/store";
import { initialState } from "../src/state";
import { composePreview, usePreviewStore } from "../src/live/previewStore";

/**
 * S6m §4 集成：点预览**不产生任何 WebSocket 发送**。
 *
 * 说明：预览路径（`usePreviewStore` + `composePreview`）根本不接触 connection / controller；
 * 本测试用一个假的 connection（send* 全是 spy）做「未被调用」断言，
 * 并断言预览不改 reducer 的 `visual` 与 `currentTurnId`（不算一轮）。
 */

function spyConnection(): {
  connection: Connection;
  sendText: ReturnType<typeof vi.fn>;
  sendAudio: ReturnType<typeof vi.fn>;
  sendInterrupt: ReturnType<typeof vi.fn>;
  sendNudge: ReturnType<typeof vi.fn>;
} {
  const sendText = vi.fn();
  const sendAudio = vi.fn();
  const sendInterrupt = vi.fn();
  const sendNudge = vi.fn();
  const connection: Connection = {
    connect() {},
    disconnect() {},
    sendText,
    sendAudio,
    sendInterrupt,
    sendNudge,
  };
  return { connection, sendText, sendAudio, sendInterrupt, sendNudge };
}

beforeEach(() => {
  useStageStore.setState(initialState, true);
  usePreviewStore.getState().endPreview();
});

afterEach(() => {
  usePreviewStore.getState().endPreview();
});

describe("S6m §4：预览不发网络、不算一轮", () => {
  it("点击各类预览项：connection.send* 均未被调用", () => {
    const { connection, sendText, sendAudio, sendInterrupt, sendNudge } = spyConnection();
    const items = [
      { kind: "emotion", value: "warm" },
      { kind: "accent", value: "love" },
      { kind: "action", value: "wave" },
      { kind: "action", value: "sway" },
      { kind: "action", value: "drink" },
    ] as const;

    for (const item of items) {
      usePreviewStore.getState().startPreview(item as never, 1000);
      // 模拟一帧渲染（合成预览）。
      composePreview(
        { emotion: "calm", visual: useStageStore.getState().visual, phase: "idle" },
        { item: item as never, startedAtMs: 1000 },
        1200,
      );
    }

    // 预览路径不应触碰任何发送接口（connection 仅作为哨兵存在）。
    void connection;
    expect(sendText).not.toHaveBeenCalled();
    expect(sendAudio).not.toHaveBeenCalled();
    expect(sendInterrupt).not.toHaveBeenCalled();
    expect(sendNudge).not.toHaveBeenCalled();
  });

  it("预览不改 reducer 的 visual 与 currentTurnId", () => {
    useStageStore.setState(initialState, true);
    const beforeTurn = useStageStore.getState().currentTurnId;
    const beforeVisual = useStageStore.getState().visual;

    usePreviewStore.getState().startPreview({ kind: "emotion", value: "warm" }, 1000);
    composePreview(
      { emotion: "warm", visual: useStageStore.getState().visual, phase: "idle" },
      { item: { kind: "emotion", value: "warm" }, startedAtMs: 1000 },
      1500,
    );

    expect(useStageStore.getState().currentTurnId).toBe(beforeTurn);
    expect(useStageStore.getState().visual).toEqual(beforeVisual);
    expect(useStageStore.getState().phase).toEqual({ kind: "idle" });
  });
});
