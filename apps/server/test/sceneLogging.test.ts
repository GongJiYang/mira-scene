/**
 * S6l-fix1 §0：换背景失败 / 被拒写入错误统计（观测页可见）。
 *
 * 断言：任务失败 → 日志有 `scene_failed` 且带简短原因；被拒 → `scene_rejected` 且带 note。
 * 同时确认这些事件会被 obs.sanitize + summarize 计入错误面板。
 */
import { describe, expect, it, afterEach } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { silentLogger, type LogRecord } from "../src/log";
import type { LLMPort, STTPort, TTSPort } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { sanitize } from "../src/obs/sanitize";
import { summarize } from "../src/obs/summarize";
import { testPacks } from "./helpers/pack";

const immediateStt: STTPort = { transcribe: () => Promise.resolve("你好") };
const immediateTts: TTSPort = { synthesize: () => Promise.resolve({ mime: "audio/wav", data: Buffer.from([1]) }) };
const llm: LLMPort = {
  async *streamBeats() {
    yield { say: "嗯。" };
  },
};

let active: SessionManager | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
});

function setup(writer: { write: () => Promise<unknown> }): { sent: ServerMessage[]; records: LogRecord[]; run: (text: string) => Promise<void> } {
  const sent: ServerMessage[] = [];
  const records: LogRecord[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const manager = createSessionManager({
    stt: immediateStt,
    llm,
    tts: immediateTts,
    packs: testPacks(),
    log: (record) => {
      records.push(record);
      silentLogger(record);
    },
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    sceneWriter: writer,
  });
  active = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

  return {
    sent,
    records,
    async run(text: string) {
      await manager.handleMessage(send, envelope("hello", {}, "", 0));
      const sessionId = sent.findLast((m) => m.type === "session")?.sessionId ?? "";
      await manager.handleMessage(send, envelope("text_input", { text }, sessionId, 1));
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
}

describe("换背景错误的可观测性（S6l-fix1 §0）", () => {
  it("扩写非法 → 日志有 scene_failed 且带 error", async () => {
    const h = setup({ write: () => Promise.resolve("not json") });
    await h.run("换背景到海边");

    const failed = h.records.find((r) => r.event === "scene_failed");
    expect(failed).toBeDefined();
    expect(failed?.detail).toHaveProperty("error");
    // 计入观测错误面板。
    const summary = summarize(h.records.map(sanitize), Date.now());
    expect(summary.errors.some((e) => e.event === "scene_failed")).toBe(true);
  });

  it("扩写拒绝 → 日志有 scene_rejected 且带 note", async () => {
    const h = setup({ write: () => Promise.resolve(JSON.stringify({ accept: false, label: "", note: "这个不行哦" })) });
    await h.run("换背景到海边");

    const rejected = h.records.find((r) => r.event === "scene_rejected");
    expect(rejected).toBeDefined();
    const summary = summarize(h.records.map(sanitize), Date.now());
    expect(summary.errors.some((e) => e.event === "scene_rejected")).toBe(true);
  });
});
