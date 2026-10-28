/**
 * freeze-fix9 §3：语音识别结果进弹幕区（纯函数 / store 层）。
 *
 * - 收到**当前轮** transcript → 排空出一条文本（Live 追加为 kind="transcript" 弹幕）；
 * - **旧轮** transcript → 不排空（D3：迟到旧轮的识别结果不得插入）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { danmakuReducer, initialDanmakuState } from "../src/live/danmaku";
import { drainTranscripts, recordTranscript, useTranscriptStore } from "../src/live/transcriptStore";

beforeEach(() => {
  useTranscriptStore.setState({ pending: [] });
});

describe("语音转写排空（freeze-fix9 §3）", () => {
  it("当前轮 transcript → 排出一条，且弹幕新增一条 transcript", () => {
    recordTranscript(3, "  你好呀  ");
    const lines = drainTranscripts(3);
    expect(lines).toEqual(["你好呀"]);

    const state = danmakuReducer(initialDanmakuState, { type: "APPEND", kind: "transcript", text: lines[0]! });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.kind).toBe("transcript");
    expect(state.items[0]?.text).toBe("你好呀");
  });

  it("旧轮 transcript（turnId 不匹配）→ 不排空，也不进弹幕（D3）", () => {
    recordTranscript(2, "上一轮说的话");
    // 当前轮已是 3：旧轮不排空。
    expect(drainTranscripts(3)).toEqual([]);
    // 仍在 pending 里（未被误删），但永远要不到（当前轮不会再回到 2）。
    expect(useTranscriptStore.getState().pending).toHaveLength(1);
  });

  it("空 / 空白识别结果被忽略（不产生空气泡）", () => {
    recordTranscript(5, "   ");
    expect(drainTranscripts(5)).toEqual([]);
  });

  it("多次排空只返回一轮的记录，且排空后清空", () => {
    recordTranscript(7, "第一句");
    recordTranscript(7, "第二句");
    expect(drainTranscripts(7)).toEqual(["第一句", "第二句"]);
    expect(drainTranscripts(7)).toEqual([]);
  });
});
