import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import {
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  SLOW_DELAY_MS,
  parseFaults,
  readFirstTokenTimeoutMs,
  shouldResume,
  withFaults,
} from "../src/adapters/faults";
import { createMockLlm } from "../src/adapters/mock/mockLlm";
import { createMockStt } from "../src/adapters/mock/mockStt";
import { createMockTts } from "../src/adapters/mock/mockTts";
import type { LogRecord } from "../src/log";
import type { LLMPort, Ports, STTPort, TTSPort } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { createInitialScene } from "../src/story";
import { testPack, testPacks } from "./helpers/pack";

/** 兜底台词取自忧奈角色包（S6b §2）。 */
const FALLBACK = testPack("yuna").fallback;

function llmBeat(say: string) {
  return { say, emotion: "neutral", suggest: null, advance: null };
}

/** 无延迟脚本：测试用假计时器时避免真实等待。 */
function scriptedLlm(beats: readonly unknown[]): LLMPort {
  return {
    async *streamBeats() {
      yield* beats;
    },
  };
}

function okTts(onCall?: () => void): TTSPort {
  return {
    synthesize() {
      onCall?.();
      return Promise.resolve({ mime: "audio/wav", data: Buffer.from([1]) });
    },
  };
}

function envelope<T extends ClientMessage["type"]>(
  type: T,
  payload: unknown,
  base: { sessionId: string; turnId: number },
): ClientMessage {
  return { v: 1, sessionId: base.sessionId, turnId: base.turnId, seq: 0, ts: 0, type, payload } as ClientMessage;
}

type SetupOptions = {
  defaultFaults?: string;
  firstTokenTimeoutMs?: number;
  dropConnection?: (sessionId: string) => void;
  base?: Partial<Ports>;
};

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  logs: LogRecord[];
  sessionId: string;
  hello(faults?: string[]): Promise<void>;
  input(turnId: number, text: string): Promise<void>;
  audio(turnId: number): Promise<void>;
  interrupt(turnId: number, interruptedTurnId: number): Promise<void>;
};

const managers: SessionManager[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const manager of managers.splice(0)) manager.dispose();
});

function setup(options: SetupOptions = {}): Harness {
  const sent: ServerMessage[] = [];
  const logs: LogRecord[] = [];
  const base: Ports = {
    stt: options.base?.stt ?? createMockStt({ delayMs: 0 }),
    llm: options.base?.llm ?? createMockLlm({ beatDelayMs: 0 }),
    tts: options.base?.tts ?? createMockTts({ delayMs: 0 }),
  };
  const manager = createSessionManager({
    ...base,
    // 与 index.ts 同构：hello 的 faults 决定每个会话的端口装饰。
    createPorts: (faults) => ({
      stt: withFaults(base.stt, "stt", faults),
      llm: withFaults(base.llm, "llm", faults),
      tts: withFaults(base.tts, "tts", faults),
    }),
    defaultFaults: parseFaults(options.defaultFaults),
    firstTokenTimeoutMs: options.firstTokenTimeoutMs,
    dropConnection: options.dropConnection,
    packs: testPacks(),
    log: (record) => logs.push(record),
    idleTimeoutMs: 24 * 60 * 60 * 1000,
  });
  managers.push(manager);

  const send: SendFn = (message) => {
    sent.push(message);
  };

  const harness: Harness = {
    manager,
    sent,
    logs,
    sessionId: "",
    async hello(faults) {
      const payload = faults === undefined ? {} : { faults };
      await manager.handleMessage(send, envelope("hello", payload, { sessionId: "", turnId: 0 }));
      const session = sent.findLast((message) => message.type === "session");
      if (!session || session.type !== "session") throw new Error("没有收到 session");
      harness.sessionId = session.sessionId;
    },
    input(turnId, text) {
      return manager.handleMessage(send, envelope("text_input", { text }, { sessionId: harness.sessionId, turnId }));
    },
    audio(turnId) {
      return manager.handleMessage(
        send,
        envelope(
          "audio_input",
          { mime: "audio/webm", dataBase64: Buffer.from("fake").toString("base64") },
          { sessionId: harness.sessionId, turnId },
        ),
      );
    },
    interrupt(turnId, interruptedTurnId) {
      return manager.handleMessage(
        send,
        envelope("interrupt", { interruptedTurnId }, { sessionId: harness.sessionId, turnId }),
      );
    },
  };

  return harness;
}

function messagesOf(harness: Harness, turnId: number) {
  return harness.sent.filter((message) => message.turnId === turnId);
}

function beatsOf(harness: Harness, turnId: number) {
  return messagesOf(harness, turnId).filter(
    (message): message is Extract<ServerMessage, { type: "beat" }> => message.type === "beat",
  );
}

function ttsSeqs(harness: Harness) {
  return harness.sent.flatMap((message) => (message.type === "tts_audio" ? [message.payload.beatSeq] : []));
}

function errorsOf(harness: Harness, turnId: number) {
  return messagesOf(harness, turnId).filter(
    (message): message is Extract<ServerMessage, { type: "error" }> => message.type === "error",
  );
}

function turnEndOf(harness: Harness, turnId: number) {
  return messagesOf(harness, turnId).findLast((message) => message.type === "turn_end");
}

describe("withFaults：端口装饰器", () => {
  it("不配置故障时原样转发调用与 AbortSignal", async () => {
    const sttSignals: AbortSignal[] = [];
    const llmSignals: AbortSignal[] = [];
    const ttsSignals: AbortSignal[] = [];
    const stt: STTPort = {
      transcribe(_audio, signal) {
        sttSignals.push(signal);
        return Promise.resolve("你好");
      },
    };
    const llm: LLMPort = {
      async *streamBeats(_ctx, signal) {
        llmSignals.push(signal);
        yield llmBeat("嗯。");
      },
    };
    const tts: TTSPort = {
      synthesize(_text, _opts, signal) {
        ttsSignals.push(signal);
        return Promise.resolve({ mime: "audio/wav", data: Buffer.from([1]) });
      },
    };
    const controller = new AbortController();
    const signal = controller.signal;

    await withFaults(stt, "stt", []).transcribe({ mime: "audio/webm", data: Buffer.from("x") }, signal);
    for await (const _raw of withFaults(llm, "llm", []).streamBeats(
      { history: [], scene: createInitialScene(), userText: "你好", pack: testPack("yuna") },
      signal,
    )) {
      // 消费一次即可。
    }
    await withFaults(tts, "tts", []).synthesize("嗯。", { emotion: "neutral" }, signal);

    expect(sttSignals).toEqual([signal]);
    expect(llmSignals).toEqual([signal]);
    expect(ttsSignals).toEqual([signal]);
  });

  it("llm_timeout：不产出任何内容，直到 signal 被中止", async () => {
    const llm = withFaults(createMockLlm(), "llm", ["llm_timeout"]);
    const controller = new AbortController();
    const next = llm
      .streamBeats({ history: [], scene: createInitialScene(), userText: "你好", pack: testPack("yuna") }, controller.signal)
      [Symbol.asyncIterator]()
      .next();

    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
  });

  it("llm_error：立即抛出非中止类错误", async () => {
    const llm = withFaults(createMockLlm(), "llm", ["llm_error"]);
    const next = llm
      .streamBeats({ history: [], scene: createInitialScene(), userText: "你好", pack: testPack("yuna") }, new AbortController().signal)
      [Symbol.asyncIterator]()
      .next();
    await expect(next).rejects.toThrow("fault:llm_error");
  });

  it("stt：返回空字符串且不调用原端口", async () => {
    let calls = 0;
    const stt: STTPort = {
      transcribe() {
        calls += 1;
        return Promise.resolve("你好");
      },
    };
    const text = await withFaults(stt, "stt", ["stt"]).transcribe(
      { mime: "audio/webm", data: Buffer.from("x") },
      new AbortController().signal,
    );
    expect(text).toBe("");
    expect(calls).toBe(0);
  });

  it("tts：每次调用都抛错；tts_once：只有第一句抛错", async () => {
    let calls = 0;
    const tts = okTts(() => {
      calls += 1;
    });
    const signal = new AbortController().signal;
    const always = withFaults(tts, "tts", ["tts"]);
    await expect(always.synthesize("一", { emotion: "neutral" }, signal)).rejects.toThrow("fault:tts");
    await expect(always.synthesize("二", { emotion: "neutral" }, signal)).rejects.toThrow("fault:tts");
    expect(calls).toBe(0);

    const once = withFaults(tts, "tts", ["tts_once"]);
    await expect(once.synthesize("一", { emotion: "neutral" }, signal)).rejects.toThrow("fault:tts");
    await expect(once.synthesize("一", { emotion: "neutral" }, signal)).resolves.toMatchObject({ mime: "audio/wav" });
    expect(calls).toBe(1);
  });

  it("slow：调用端口前等 1500ms，等待期间可被 signal 打断", async () => {
    let calls = 0;
    const tts = okTts(() => {
      calls += 1;
    });
    const slow = withFaults(tts, "tts", ["slow"]);
    const controller = new AbortController();
    const pending = slow.synthesize("嗯。", { emotion: "neutral" }, controller.signal);

    await vi.advanceTimersByTimeAsync(SLOW_DELAY_MS - 1);
    expect(calls).toBe(0);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(SLOW_DELAY_MS);
    expect(calls).toBe(0);
  });

  it("media 为预留类型：原样返回", () => {
    const port = { generate: () => Promise.resolve("media") };
    expect(withFaults(port, "media", ["tts"])).toBe(port);
  });
});

describe("故障配置解析", () => {
  it("FAULTS 字符串 / hello 数组 → 已知故障去重", () => {
    expect(parseFaults("tts, slow,tts, unknown")).toEqual(["tts", "slow"]);
    expect(parseFaults(["stt", "ws_drop", "stt"])).toEqual(["stt", "ws_drop"]);
    expect(parseFaults("")).toEqual([]);
    expect(parseFaults(undefined)).toEqual([]);
  });

  it("首 token 超时可配置，非法值直接抛错", () => {
    expect(readFirstTokenTimeoutMs({})).toBe(DEFAULT_FIRST_TOKEN_TIMEOUT_MS);
    expect(readFirstTokenTimeoutMs({ LLM_FIRST_TOKEN_TIMEOUT_MS: "2500" })).toBe(2_500);
    expect(() => readFirstTokenTimeoutMs({ LLM_FIRST_TOKEN_TIMEOUT_MS: "abc" })).toThrow();
    expect(() => readFirstTokenTimeoutMs({ LLM_FIRST_TOKEN_TIMEOUT_MS: "0" })).toThrow();
  });
});

describe("shouldResume：faults 集合相等才恢复（freeze-fix2 §2）", () => {
  it("相同 → 恢复", () => {
    expect(shouldResume(["tts"], ["tts"])).toBe(true);
    expect(shouldResume([], [])).toBe(true);
    expect(shouldResume(["tts", "slow"], ["tts", "slow"])).toBe(true);
  });

  it("顺序不同 → 恢复（与顺序无关）", () => {
    expect(shouldResume(["tts", "slow"], ["slow", "tts"])).toBe(true);
  });

  it("重复项不影响集合比较 → 恢复", () => {
    expect(shouldResume(["tts", "tts"], ["tts"])).toBe(true);
  });

  it("新增故障 → 不恢复", () => {
    expect(shouldResume([], ["tts"])).toBe(false);
    expect(shouldResume(["tts"], ["tts", "slow"])).toBe(false);
  });

  it("清空故障 → 不恢复", () => {
    expect(shouldResume(["tts"], [])).toBe(false);
    expect(shouldResume(["tts", "slow"], ["tts"])).toBe(false);
  });
});

describe("降级路径：llm_timeout", () => {
  it("下发兜底台词（guarded）→ error{llm_timeout,retryable:true} → turn_end{error}", async () => {
    const harness = setup({ firstTokenTimeoutMs: 1_000, base: { llm: createMockLlm() } });
    await harness.hello(["llm_timeout"]);

    const turn = harness.input(1, "你好");
    await vi.advanceTimersByTimeAsync(1_000);
    await turn;

    expect(messagesOf(harness, 1).map((message) => message.type)).toEqual(["beat", "error", "turn_end"]);
    expect(beatsOf(harness, 1)[0]?.payload.beat).toMatchObject({
      seq: 0,
      say: FALLBACK.llm_timeout,
      emotion: "guarded",
    });
    expect(errorsOf(harness, 1)).toMatchObject([{ payload: { code: "llm_timeout", retryable: true } }]);
    expect(turnEndOf(harness, 1)?.payload).toEqual({ reason: "error" });
    expect(harness.logs.filter((record) => record.event === "fallback_used")).toMatchObject([
      { detail: { category: "llm_timeout" } },
    ]);
  });
});

describe("降级路径：llm_error", () => {
  it("沿用通用失败路径：error{turn_failed} → turn_end{error}", async () => {
    const harness = setup({ base: { llm: createMockLlm() } });
    await harness.hello(["llm_error"]);
    await harness.input(1, "你好");

    expect(errorsOf(harness, 1)).toMatchObject([{ payload: { code: "turn_failed", retryable: true } }]);
    expect(turnEndOf(harness, 1)?.payload).toEqual({ reason: "error" });
  });
});

describe("降级路径：TTS", () => {
  it("tts_once：第一句重试成功，不降级、两个 tts_audio 都在", async () => {
    let calls = 0;
    const harness = setup({
      base: { llm: scriptedLlm([llmBeat("第一句"), llmBeat("第二句")]), tts: okTts(() => (calls += 1)) },
    });
    await harness.hello(["tts_once"]);
    await harness.input(1, "你好");

    expect(ttsSeqs(harness)).toEqual([0, 1]);
    expect(calls).toBe(2);
    expect(errorsOf(harness, 1)).toEqual([]);
    expect(turnEndOf(harness, 1)?.payload).toEqual({ reason: "done" });
    expect(harness.logs.some((record) => record.event === "fallback_used")).toBe(false);
  });

  it("非中止失败会原句重试 1 次：两句都先失败一次后成功", async () => {
    const attempts = new Map<string, number>();
    const tts: TTSPort = {
      synthesize(text) {
        const count = attempts.get(text) ?? 0;
        attempts.set(text, count + 1);
        if (count === 0) return Promise.reject(new Error("flaky tts"));
        return Promise.resolve({ mime: "audio/wav", data: Buffer.from([count]) });
      },
    };
    const harness = setup({ base: { llm: scriptedLlm([llmBeat("第一句"), llmBeat("第二句")]), tts } });
    await harness.hello();
    await harness.input(1, "你好");

    expect([...attempts.values()]).toEqual([2, 2]);
    expect(ttsSeqs(harness)).toEqual([0, 1]);
    expect(errorsOf(harness, 1)).toEqual([]);
    expect(turnEndOf(harness, 1)?.payload).toEqual({ reason: "done" });
  });

  it("tts：全部无声 beat，逐句重试 1 次后降级，本轮正常结束", async () => {
    let calls = 0;
    const tts: TTSPort = {
      synthesize() {
        calls += 1;
        return Promise.reject(new Error("tts boom"));
      },
    };
    const harness = setup({ base: { llm: scriptedLlm([llmBeat("第一句"), llmBeat("第二句")]), tts } });
    await harness.hello(["tts"]);
    await harness.input(1, "你好");

    // 装饰器在调用原端口前就抛错，所以原端口一次都不会被调到。
    expect(calls).toBe(0);
    expect(ttsSeqs(harness)).toEqual([]);
    expect(beatsOf(harness, 1)).toHaveLength(2);
    const degraded = errorsOf(harness, 1);
    expect(degraded).toHaveLength(2);
    expect(degraded.every((message) => message.payload.code === "tts_degraded")).toBe(true);
    expect(degraded.every((message) => message.payload.retryable === false)).toBe(true);
    expect(turnEndOf(harness, 1)?.payload).toEqual({ reason: "done" });
    expect(harness.sent.findLast((message) => message.type === "turn_end")).toMatchObject({ payload: { reason: "done" } });
    expect(harness.logs.filter((record) => record.event === "fallback_used")).toMatchObject([
      { detail: { category: "tts" } },
    ]);
  });
});

describe("降级路径：STT 空结果", () => {
  it("下发「没听清」beat 后正常结束，不调用 LLM", async () => {
    let llmCalls = 0;
    let sttCalls = 0;
    const llm: LLMPort = {
      async *streamBeats() {
        llmCalls += 1;
      },
    };
    const stt: STTPort = {
      transcribe() {
        sttCalls += 1;
        return Promise.resolve("你好");
      },
    };
    const harness = setup({ base: { llm, stt } });
    await harness.hello(["stt"]);
    await harness.audio(1);

    expect(messagesOf(harness, 1).map((message) => message.type)).toEqual(["beat", "turn_end"]);
    expect(beatsOf(harness, 1)[0]?.payload.beat).toMatchObject({
      seq: 0,
      say: FALLBACK.stt_empty,
      emotion: "guarded",
    });
    expect(turnEndOf(harness, 1)?.payload).toEqual({ reason: "done" });
    expect(llmCalls).toBe(0);
    expect(sttCalls).toBe(0);
    expect(harness.logs.filter((record) => record.event === "fallback_used")).toMatchObject([
      { detail: { category: "stt_empty" } },
    ]);
  });
});

describe("slow：等待期间被中止", () => {
  it("旧轮在中止后发出的消息数为 0", async () => {
    let sttCalls = 0;
    const stt: STTPort = {
      transcribe() {
        sttCalls += 1;
        return Promise.resolve("你好");
      },
    };
    const harness = setup({ base: { stt, llm: scriptedLlm([llmBeat("嗯。")]) } });
    await harness.hello(["slow"]);

    const turn = harness.audio(1);
    await vi.advanceTimersByTimeAsync(SLOW_DELAY_MS - 1);
    expect(sttCalls).toBe(0);

    const marker = harness.sent.length;
    await harness.interrupt(2, 1);
    await vi.advanceTimersByTimeAsync(SLOW_DELAY_MS);
    await turn;

    expect(harness.sent.slice(marker).filter((message) => message.turnId === 1)).toEqual([]);
    expect(sttCalls).toBe(0);
    expect(turnEndOf(harness, 1)).toBeUndefined();
  });
});

describe("ws_drop：第 2 个 beat 后关闭连接", () => {
  it("只发 2 个 beat，然后调用传输层关闭回调", async () => {
    const dropped: string[] = [];
    const harness = setup({
      base: { llm: scriptedLlm([llmBeat(""), llmBeat(""), llmBeat("")]) },
      dropConnection: (sessionId) => dropped.push(sessionId),
    });
    await harness.hello(["ws_drop"]);
    await harness.input(1, "你好");

    expect(beatsOf(harness, 1)).toHaveLength(2);
    expect(dropped).toEqual([harness.sessionId]);
    expect(turnEndOf(harness, 1)).toBeUndefined();
    expect(harness.logs.filter((record) => record.event === "ws_drop")).toMatchObject([
      { detail: { afterBeat: 2 } },
    ]);
  });
});

describe("故障来源：环境变量默认值", () => {
  it("defaultFaults 在 hello 未带 faults 时生效", async () => {
    const harness = setup({ defaultFaults: "tts", base: { llm: scriptedLlm([llmBeat("嗯。")]), tts: okTts() } });
    await harness.hello();
    await harness.input(1, "你好");

    expect(ttsSeqs(harness)).toEqual([]);
    expect(errorsOf(harness, 1).map((message) => message.payload.code)).toEqual(["tts_degraded"]);
    expect(turnEndOf(harness, 1)?.payload).toEqual({ reason: "done" });
  });

  it("hello 的空 faults 数组覆盖默认值", async () => {
    const harness = setup({ defaultFaults: "tts", base: { llm: scriptedLlm([llmBeat("嗯。")]), tts: okTts() } });
    await harness.hello([]);
    await harness.input(1, "你好");

    expect(ttsSeqs(harness)).toEqual([0]);
    expect(errorsOf(harness, 1)).toEqual([]);
    expect(turnEndOf(harness, 1)?.payload).toEqual({ reason: "done" });
  });
});

describe("不配置故障时行为不变", () => {
  it("Mock 端口完整跑通：beats、tts_audio、snapshot、turn_end{done}，无降级日志", async () => {
    const harness = setup();
    await harness.hello();

    const turn = harness.input(1, "你好");
    await vi.advanceTimersByTimeAsync(2_000);
    await turn;

    expect(beatsOf(harness, 1)).toHaveLength(3);
    expect(ttsSeqs(harness)).toEqual([0, 1]);
    expect(harness.sent.filter((message) => message.type === "state_snapshot")).toHaveLength(1);
    expect(turnEndOf(harness, 1)?.payload).toEqual({ reason: "done" });
    expect(errorsOf(harness, 1)).toEqual([]);
    expect(harness.logs.some((record) => record.event === "fallback_used" || record.event === "ws_drop")).toBe(false);
  });
});
