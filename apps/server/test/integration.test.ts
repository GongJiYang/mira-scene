import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { createDeepSeekLlm } from "../src/adapters/deepseek/deepseekLlm";
import { createFishTts } from "../src/adapters/fish/fishTts";
import { createMockStt } from "../src/adapters/mock/mockStt";
import type { LogRecord } from "../src/log";
import { loadPromptTemplate } from "../src/prompts/loader";
import { withPaceCheck } from "../src/quality/paceGuard";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";

/** 1 秒 128kbps 的音频字节数：5 个字的句子 ≈ 5 字/秒，落在正常范围。 */
const ONE_SECOND_BYTES = 16_000;

function dataChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

function sse(parts: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** 假 fetch：chat/completions 走 SSE，tts 返回一段 mp3 字节。 */
function makeFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/chat/completions")) {
      return sse([
        dataChunk('{"say":"雨还在下。","emotion":"calm"}\n'),
        dataChunk('{"say":"先坐吧。","emotion":"calm"}\n'),
        "data: [DONE]\n\n",
      ]);
    }
    if (url.endsWith("/tts")) {
      return new Response(Buffer.alloc(ONE_SECOND_BYTES), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  sessionId: string;
  hello(): Promise<void>;
  input(turnId: number, text: string): Promise<void>;
  playbackStarted(turnId: number, seq: number, clientMs: number): Promise<void>;
};

let activeManager: SessionManager | null = null;

afterEach(() => {
  activeManager?.dispose();
  activeManager = null;
});

function setup(logs: LogRecord[]): Harness {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const prompt = loadPromptTemplate();
  const fetchImpl = makeFetch();
  const manager = createSessionManager({
    stt: createMockStt({ delayMs: 0 }),
    llm: createDeepSeekLlm({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "test-key",
      model: "deepseek-chat",
      prompt,
      fetch: fetchImpl,
      log: (record) => logs.push(record),
    }),
    tts: withPaceCheck(
      createFishTts({ baseUrl: "https://api.fish.audio/v1", apiKey: "k", voiceId: "voice-1", model: "s2.1-pro-free", fetch: fetchImpl }),
      { log: (record) => logs.push(record) },
    ),
    log: (record) => logs.push(record),
  });
  activeManager = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number, seq = 0): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq, ts: Date.now(), type, payload }) as ClientMessage;

  let sessionId = "";
  return {
    manager,
    sent,
    get sessionId() {
      return sessionId;
    },
    async hello() {
      await manager.handleMessage(send, envelope("hello", {}, "", 0));
      const session = sent.findLast((message) => message.type === "session");
      if (!session || session.type !== "session") throw new Error("没有收到 session");
      sessionId = session.sessionId;
    },
    async input(turnId, text) {
      await manager.handleMessage(send, envelope("text_input", { text }, sessionId, turnId));
    },
    async playbackStarted(turnId, seq, clientMs) {
      await manager.handleMessage(
        send,
        envelope("playback_started", { turnId, seq, clientMs }, sessionId, turnId, seq),
      );
    },
  };
}

describe("集成：文字 → LLM 流 → 导演层 → TTS → 下发（假 fetch，不联网）", () => {
  it("跑完整一轮并记录各阶段计时", async () => {
    const logs: LogRecord[] = [];
    const harness = setup(logs);
    await harness.hello();
    await harness.input(1, "你好，外面还在下雨吗？");

    const types = harness.sent.map((message) => message.type);
    expect(types[0]).toBe("session");
    expect(types.at(-1)).toBe("turn_end");
    expect(types).toContain("state_snapshot");

    const beats = harness.sent.filter((message) => message.type === "beat" && message.turnId === 1);
    expect(beats).toHaveLength(2);
    expect(beats.map((message) => (message.type === "beat" ? message.payload.beat.say : ""))).toEqual(["雨还在下。", "先坐吧。"]);

    const tts = harness.sent.filter((message) => message.type === "tts_audio" && message.turnId === 1);
    expect(tts).toHaveLength(2);
    expect(tts.every((message) => message.type === "tts_audio" && message.payload.mime === "audio/mpeg")).toBe(true);

    const turnLogs = logs.filter((record) => record.turnId === 1);
    expect(logs.find((record) => record.event === "prompt_version")?.detail).toEqual({ prompt_version: "rin.v1" });
    for (const event of ["turn_start", "llm_first_beat", "tts_first_audio", "turn_end"]) {
      const record = turnLogs.find((entry) => entry.event === event);
      expect(record, `缺少计时事件 ${event}`).toBeDefined();
      expect(typeof record?.ms).toBe("number");
    }
    const turnEnd = harness.sent.findIndex((message) => message.type === "turn_end");
    const lastTts = harness.sent.findLastIndex((message) => message.type === "tts_audio");
    expect(turnEnd).toBeGreaterThan(lastTts);
  });

  it("playback_started：收到后记录 first_audio_ms", async () => {
    const logs: LogRecord[] = [];
    const harness = setup(logs);
    await harness.hello();
    await harness.input(1, "你好");
    await harness.playbackStarted(1, 0, 1_234);

    const record = logs.find((entry) => entry.event === "playback_started");
    expect(record?.turnId).toBe(1);
    expect(record?.detail).toMatchObject({ seq: 0, clientMs: 1_234, first_audio_ms: 1_234 });
  });
});

describe("会话：playback_started 消息流", () => {
  it("未知会话返回 unknown_session；有效会话写入日志", async () => {
    const logs: LogRecord[] = [];
    const sent: ServerMessage[] = [];
    const send: SendFn = (message) => void sent.push(message);
    const manager = createSessionManager({
      stt: createMockStt({ delayMs: 0 }),
      llm: { async *streamBeats() {} },
      tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from([1]) }) },
      log: (record) => logs.push(record),
    });
    activeManager = manager;

    await manager.handleMessage(
      send,
      ({ v: 1, sessionId: "missing", turnId: 1, seq: 0, ts: Date.now(), type: "playback_started", payload: { turnId: 1, seq: 0, clientMs: 10 } } as ClientMessage),
    );
    expect(sent[0]).toMatchObject({ type: "error", payload: { code: "unknown_session" } });
    expect(logs.some((record) => record.event === "playback_started")).toBe(false);
  });
});
