import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { withFaults } from "../src/adapters/faults";
import { createMockLlm } from "../src/adapters/mock/mockLlm";
import { createMockStt } from "../src/adapters/mock/mockStt";
import { createMockTts } from "../src/adapters/mock/mockTts";
import type { LogRecord } from "../src/log";
import type { LLMPort, Ports, STTPort, TTSPort } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPack, testPacks } from "./helpers/pack";

/**
 * S6b §2：情景化兜底。
 * 服务端四类（stt_empty / stt_failed / llm_timeout / turn_failed）各自发出对应角色包的台词；
 * 客户端本地播放的 offline 由 apps/client/test/offlineFallback.test.ts 覆盖。
 */

const PACK = testPack("yuna");

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  logs: LogRecord[];
  hello(characterId?: string, faults?: string[]): Promise<void>;
  input(turnId: number, text: string): Promise<void>;
  audio(turnId: number): Promise<void>;
};

let active: SessionManager | null = null;

type SetupOptions = {
  llm?: LLMPort;
  stt?: STTPort;
  tts?: TTSPort;
  firstTokenTimeoutMs?: number;
};

function setup(options: SetupOptions = {}): Harness {
  const sent: ServerMessage[] = [];
  const logs: LogRecord[] = [];
  const base: Ports = {
    stt: options.stt ?? createMockStt({ delayMs: 0 }),
    llm: options.llm ?? createMockLlm({ beatDelayMs: 0 }),
    tts: options.tts ?? createMockTts({ delayMs: 0 }),
  };
  const manager = createSessionManager({
    ...base,
    createPorts: (faults) => ({
      stt: withFaults(base.stt, "stt", faults),
      llm: withFaults(base.llm, "llm", faults),
      tts: withFaults(base.tts, "tts", faults),
    }),
    packs: testPacks(),
    firstTokenTimeoutMs: options.firstTokenTimeoutMs,
    log: (record) => logs.push(record),
    idleTimeoutMs: 24 * 60 * 60 * 1000,
  });
  active = manager;

  const send: SendFn = (message) => void sent.push(message);
  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;
  const sessionIdOf = (): string => sent.findLast((message) => message.type === "session")?.sessionId ?? "";

  return {
    manager,
    sent,
    logs,
    async hello(characterId, faults) {
      const payload: Record<string, unknown> = {};
      if (characterId !== undefined) payload.characterId = characterId;
      if (faults !== undefined) payload.faults = faults;
      await manager.handleMessage(send, envelope("hello", payload, "", 0));
    },
    input: (turnId, text) => manager.handleMessage(send, envelope("text_input", { text }, sessionIdOf(), turnId)),
    audio: (turnId) =>
      manager.handleMessage(
        send,
        envelope("audio_input", { mime: "audio/webm", dataBase64: Buffer.from("fake").toString("base64") }, sessionIdOf(), turnId),
      ),
  };
}

const beatsOf = (sent: ServerMessage[], turnId: number) =>
  sent.flatMap((message) => (message.type === "beat" && message.turnId === turnId ? [message.payload.beat] : []));

const errorsOf = (sent: ServerMessage[], turnId: number) =>
  sent.flatMap((message) => (message.type === "error" && message.turnId === turnId ? [message.payload] : []));

const turnEndOf = (sent: ServerMessage[], turnId: number) =>
  sent.filter((message) => message.type === "turn_end" && message.turnId === turnId).at(-1);

afterEach(() => {
  vi.useRealTimers();
  active?.dispose();
  active = null;
});

describe("§2 兜底：stt_empty", () => {
  it("STT 返回空串 → 说 pack 的 stt_empty 台词，正常结束，不调用 LLM", async () => {
    let llmCalls = 0;
    const llm: LLMPort = {
      async *streamBeats() {
        llmCalls += 1;
      },
    };
    const harness = setup({ llm });
    await harness.hello("yuna", ["stt"]);
    await harness.audio(1);

    expect(beatsOf(harness.sent, 1)[0]).toMatchObject({ say: PACK.fallback.stt_empty, emotion: "guarded" });
    expect(turnEndOf(harness.sent, 1)?.payload).toEqual({ reason: "done" });
    expect(llmCalls).toBe(0);
    expect(harness.logs.filter((record) => record.event === "fallback_used")).toMatchObject([
      { detail: { category: "stt_empty" } },
     ]);
   });

});

describe("§2 兜底：stt_failed", () => {
  it("STT 抛错 → 说 pack 的 stt_failed 台词，turn_end{done}（不再 turn_failed）", async () => {
    const stt: STTPort = {
      transcribe() {
        return Promise.reject(new Error("network down"));
      },
    };
    const harness = setup({ stt });
    await harness.hello("yuna");
    await harness.audio(1);

    expect(beatsOf(harness.sent, 1)[0]).toMatchObject({ say: PACK.fallback.stt_failed, emotion: "guarded" });
    expect(errorsOf(harness.sent, 1)).toEqual([]);
    expect(turnEndOf(harness.sent, 1)?.payload).toEqual({ reason: "done" });
    expect(harness.logs.filter((record) => record.event === "fallback_used")).toMatchObject([
      { detail: { category: "stt_failed" } },
    ]);
  });

  it("故障注入 stt_error 走同一条路径", async () => {
    const harness = setup();
    await harness.hello("yuna", ["stt_error"]);
    await harness.audio(1);

    expect(beatsOf(harness.sent, 1)[0]?.say).toBe(PACK.fallback.stt_failed);
    expect(turnEndOf(harness.sent, 1)?.payload).toEqual({ reason: "done" });
  });
});

describe("§2 兜底：llm_timeout", () => {
  it("首 token 超时 → 说 pack 的 llm_timeout 台词，error{llm_timeout,retryable:true}，turn_end{error}", async () => {
    vi.useFakeTimers();
    const harness = setup({ firstTokenTimeoutMs: 1_000 });
    await harness.hello("yuna", ["llm_timeout"]);

    const turn = harness.input(1, "你好");
    await vi.advanceTimersByTimeAsync(1_000);
    await turn;

    expect(beatsOf(harness.sent, 1)[0]).toMatchObject({ say: PACK.fallback.llm_timeout, emotion: "guarded" });
    expect(errorsOf(harness.sent, 1)).toMatchObject([{ code: "llm_timeout", retryable: true }]);
    expect(turnEndOf(harness.sent, 1)?.payload).toEqual({ reason: "error" });
  });
});

describe("§2 兜底：turn_failed", () => {
  it("LLM 抛错 → 记录错误日志 + 说 pack 的 turn_failed 台词；error 仍为 turn_failed/retryable", async () => {
    const llm: LLMPort = {
      streamBeats() {
        throw new Error("boom");
      },
    };
    const harness = setup({ llm });
    await harness.hello("yuna");
    await harness.input(1, "你好");

    expect(beatsOf(harness.sent, 1)[0]).toMatchObject({ say: PACK.fallback.turn_failed, emotion: "guarded" });
    expect(errorsOf(harness.sent, 1)).toMatchObject([{ code: "turn_failed", message: "boom", retryable: true }]);
    expect(turnEndOf(harness.sent, 1)?.payload).toEqual({ reason: "error" });
    // 服务端照常记录错误日志。
    expect(harness.logs.some((record) => record.event === "turn_failed")).toBe(true);
    expect(harness.logs.filter((record) => record.event === "fallback_used")).toMatchObject([
      { detail: { category: "turn_failed" } },
    ]);
  });
});

describe("§2 兜底：五类台词都来自角色包", () => {
  it("忧奈的兜底台词逐类非空（D43 只剩一个角色）", () => {
    for (const category of ["stt_empty", "stt_failed", "llm_timeout", "turn_failed", "offline"] as const) {
      expect(PACK.fallback[category].length).toBeGreaterThan(0);
    }
  });
});
