/**
 * freeze-fix2 §2：`?fail=` 在恢复会话时不生效的修复契约。
 *
 * - faults 集合相等 → 恢复旧会话（同一页面断线重连，ws_drop 演示不受影响）；
 * - faults 变化（新增 / 清空）→ 按新会话处理（本次请求的 faults 生效），并记 resume_skipped 日志。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import type { LogRecord } from "../src/log";
import type { LLMPort, STTPort, TTSPort } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPacks } from "./helpers/pack";

const immediateStt: STTPort = { transcribe: () => Promise.resolve("你好") };
const immediateTts: TTSPort = { synthesize: () => Promise.resolve({ mime: "audio/wav", data: Buffer.from([1]) }) };

function oneBeatLlm(): LLMPort {
  return {
    async *streamBeats() {
      yield { say: "嗯。", emotion: "neutral", suggest: null, advance: null };
    },
  };
}

let active: SessionManager | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
});

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  logs: LogRecord[];
  hello(payload: { resumeSessionId?: string; faults?: string[] }): Promise<Extract<ServerMessage, { type: "session" }>>;
  input(sessionId: string, turnId: number, text: string): Promise<void>;
};

function setup(): Harness {
  const sent: ServerMessage[] = [];
  const logs: LogRecord[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const manager = createSessionManager({
    stt: immediateStt,
    llm: oneBeatLlm(),
    tts: immediateTts,
    packs: testPacks(),
    log: (record) => logs.push(record),
    idleTimeoutMs: 24 * 60 * 60 * 1000,
  });
  active = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

  return {
    manager,
    sent,
    logs,
    async hello(payload) {
      await manager.handleMessage(send, envelope("hello", payload, payload.resumeSessionId ?? "", 0));
      const message = sent.findLast((m) => m.type === "session");
      if (!message || message.type !== "session") throw new Error("没有收到 session");
      return message;
    },
    input(sessionId, turnId, text) {
      return manager.handleMessage(send, envelope("text_input", { text }, sessionId, turnId));
    },
  };
}

function sessionCreatedFaults(logs: LogRecord[]): unknown {
  return logs.findLast((record) => record.event === "session_created")?.detail;
}

describe("恢复会话：faults 变化时不生效的修复（freeze-fix2 §2）", () => {
  it("同一 resumeSessionId + 新增 faults → 新会话且 faults 含 tts；相同 faults 重连 → 恢复", async () => {
    const harness = setup();

    // 1) 先建会话（无 faults）。
    const first = await harness.hello({});
    expect(sessionCreatedFaults(harness.logs)).toMatchObject({ faults: [] });

    // 2) 用同一 resumeSessionId 但带 faults:["tts"] → 不恢复，建新会话，faults 含 tts。
    const withFault = await harness.hello({ resumeSessionId: first.sessionId, faults: ["tts"] });
    expect(withFault.sessionId).not.toBe(first.sessionId);
    expect(sessionCreatedFaults(harness.logs)).toMatchObject({ faults: ["tts"] });
    expect(harness.logs.filter((record) => record.event === "resume_skipped")).toMatchObject([
      { detail: { reason: "faults_changed" } },
    ]);

    // 新会话的 faults 确实生效：tts 报错 → 降级为无声 beat。
    await harness.input(withFault.sessionId, 1, "你好");
    const degraded = harness.sent.filter(
      (message) => message.type === "error" && message.payload.code === "tts_degraded",
    );
    expect(degraded).toHaveLength(1);

    // 3) 用相同 faults 重连 → 恢复（同一页面断线重连，ws_drop 演示依赖此行为）。
    const resumed = await harness.hello({ resumeSessionId: withFault.sessionId, faults: ["tts"] });
    expect(resumed.sessionId).toBe(withFault.sessionId);
    expect(harness.logs.filter((record) => record.event === "session_resumed")).toHaveLength(1);
  });

  it("清空 faults → 不恢复（按新会话处理）", async () => {
    const harness = setup();
    const first = await harness.hello({ faults: ["tts"] });
    const cleared = await harness.hello({ resumeSessionId: first.sessionId, faults: [] });
    expect(cleared.sessionId).not.toBe(first.sessionId);
    expect(sessionCreatedFaults(harness.logs)).toMatchObject({ faults: [] });
    expect(harness.logs.some((record) => record.event === "resume_skipped")).toBe(true);
  });
});
