import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage, StoryNode } from "@mira/protocol";
import { createAbortError } from "../src/abort";
import { createMockLlm } from "../src/adapters/mock/mockLlm";
import { createMockStt } from "../src/adapters/mock/mockStt";
import { createMockTts } from "../src/adapters/mock/mockTts";
import { silentLogger } from "../src/log";
import type { LLMPort, STTPort, TTSPort } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";

type RawBeat = {
  seq?: number;
  say: string;
  emotion?: string;
  pose?: string;
  action?: string | null;
  camera?: string | null;
  fx?: string | null;
  media?: { type: string; id: string } | null;
  story?: { advance: StoryNode } | null;
};

function rawBeat(say: string, extra: Partial<RawBeat> = {}): RawBeat {
  return {
    seq: 0,
    say,
    emotion: "neutral",
    pose: "sit",
    action: null,
    camera: null,
    fx: null,
    media: null,
    story: null,
    ...extra,
  };
}

/** 只在 signal 中止时才结束的挂起：用于精确控制「轮次仍在进行中」。 */
function untilAborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(createAbortError());
  const { promise, reject } = Promise.withResolvers<never>();
  signal.addEventListener("abort", () => reject(createAbortError()), { once: true });
  return promise;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** 按顺序消费脚本：每次 streamBeats 取下一个脚本。 */
function scriptedLlm(scripts: RawBeat[][]): LLMPort {
  const pending = [...scripts];
  return {
    async *streamBeats() {
      yield* (pending.shift() ?? []);
    },
  };
}

function envelope<T extends ClientMessage["type"]>(
  type: T,
  payload: unknown,
  base: { sessionId: string; turnId: number; seq?: number },
): ClientMessage {
  return {
    v: 1,
    sessionId: base.sessionId,
    turnId: base.turnId,
    seq: base.seq ?? 0,
    ts: Date.now(),
    type,
    payload,
  } as ClientMessage;
}

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  send: SendFn;
  sessionId: string;
  /** 条件成立时 resolve；不轮询、不依赖真实时钟。 */
  waitUntil(predicate: () => boolean): Promise<void>;
  hello(resumeSessionId?: string): Promise<ServerMessage & { type: "session" }>;
  input(turnId: number, text: string): Promise<void>;
  audio(turnId: number): Promise<void>;
  interrupt(turnId: number, interruptedTurnId: number): Promise<void>;
};

let activeManager: SessionManager | null = null;

function setup(ports: { llm?: LLMPort; stt?: STTPort; tts?: TTSPort } = {}): Harness {
  const sent: ServerMessage[] = [];
  let waiters: Array<() => void> = [];
  const send: SendFn = (message) => {
    sent.push(message);
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter();
  };
  const manager = createSessionManager({
    stt: ports.stt ?? createMockStt({ delayMs: 0 }),
    llm: ports.llm ?? createMockLlm({ beatDelayMs: 0 }),
    tts: ports.tts ?? createMockTts({ delayMs: 0 }),
    log: silentLogger,
  });
  activeManager = manager;

  const waitUntil = (predicate: () => boolean): Promise<void> => {
    if (predicate()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const check = () => (predicate() ? resolve() : waiters.push(check));
    waiters.push(check);
    return promise;
  };

  const harness: Harness = {
    manager,
    sent,
    send,
    sessionId: "",
    waitUntil,
    async hello(resumeSessionId) {
      await manager.handleMessage(send, envelope("hello", { resumeSessionId }, { sessionId: resumeSessionId ?? "", turnId: 0 }));
      const message = sent.findLast((candidate) => candidate.type === "session");
      if (!message || message.type !== "session") throw new Error("没有收到 session");
      harness.sessionId = message.sessionId;
      return message;
    },
    input(turnId, text) {
      return manager.handleMessage(send, envelope("text_input", { text }, { sessionId: harness.sessionId, turnId }));
    },
    audio(turnId) {
      return manager.handleMessage(
        send,
        envelope("audio_input", { mime: "audio/webm", dataBase64: Buffer.from("fake").toString("base64") }, {
          sessionId: harness.sessionId,
          turnId,
        }),
      );
    },
    interrupt(turnId, interruptedTurnId) {
      return manager.handleMessage(send, envelope("interrupt", { interruptedTurnId }, { sessionId: harness.sessionId, turnId }));
    },
  };

  return harness;
}

function beatsOf(sent: ServerMessage[], turnId: number) {
  return sent.filter((message) => message.type === "beat" && message.turnId === turnId);
}

function ttsSeqs(sent: ServerMessage[]) {
  return sent.flatMap((message) => (message.type === "tts_audio" ? [message.payload.beatSeq] : []));
}

function turnEndsOf(sent: ServerMessage[], turnId: number) {
  return sent.filter((message) => message.type === "turn_end" && message.turnId === turnId);
}

afterEach(() => {
  activeManager?.dispose();
  activeManager = null;
});

describe("session：输入与中止", () => {
  it("新输入会 abort 上一轮（LLM 观察到 signal.aborted）", async () => {
    const flags: Array<{ text: string; aborted: boolean }> = [];
    const llm: LLMPort = {
      async *streamBeats(ctx, signal) {
        yield rawBeat("嗯。");
        if (ctx.userText === "第一句") {
          await untilAborted(signal).catch(() => undefined);
          flags.push({ text: ctx.userText, aborted: signal.aborted });
          return;
        }
        flags.push({ text: ctx.userText, aborted: signal.aborted });
      },
    };
    const harness = setup({ llm });
    await harness.hello();

    const first = harness.input(1, "第一句");
    await harness.waitUntil(() => beatsOf(harness.sent, 1).length > 0);
    const second = harness.input(2, "第二句");
    await Promise.all([first, second]);

    expect(flags.find((entry) => entry.text === "第一句")?.aborted).toBe(true);
    expect(flags.find((entry) => entry.text === "第二句")?.aborted).toBe(false);
  });

  it("被中止的一轮在中止之后发送消息数为 0（含 turn_end）", async () => {
    const llm: LLMPort = {
      async *streamBeats(ctx, signal) {
        yield rawBeat("一");
        if (ctx.userText === "打断") return;
        await untilAborted(signal).catch(() => undefined);
        yield rawBeat("二");
      },
    };
    const harness = setup({ llm });
    await harness.hello();

    const first = harness.input(1, "开始");
    await harness.waitUntil(() => beatsOf(harness.sent, 1).length > 0);

    const marker = harness.sent.length;
    const second = harness.input(2, "打断");
    await Promise.all([first, second]);

    const staleAfterAbort = harness.sent.slice(marker).filter((message) => message.turnId === 1);
    expect(staleAfterAbort).toEqual([]);
    expect(turnEndsOf(harness.sent, 1)).toEqual([]);
    expect(harness.sent.findLast((message) => message.type === "turn_end")?.turnId).toBe(2);
  });

  it("turnId 不递增 → stale_turn，当前轮不受影响继续完成", async () => {
    const release = Promise.withResolvers<void>();
    const llm: LLMPort = {
      async *streamBeats() {
        yield rawBeat("一");
        await release.promise;
        yield rawBeat("二");
      },
    };
    const harness = setup({ llm });
    await harness.hello();

    const running = harness.input(1, "正常");
    await harness.waitUntil(() => beatsOf(harness.sent, 1).length > 0);

    await harness.input(1, "重复");
    const stale = harness.sent.find((message) => message.type === "error");
    expect(stale).toMatchObject({ type: "error", payload: { code: "stale_turn", retryable: false } });
    expect(turnEndsOf(harness.sent, 1)).toEqual([]);

    release.resolve();
    await running;
    expect(harness.sent.find((message) => message.type === "turn_end")?.payload).toEqual({ reason: "done" });
    expect(beatsOf(harness.sent, 1)).toHaveLength(2);
  });
});

describe("session：TTS 流水线", () => {
  it("tts_audio 按 seq 顺序发送（seq1 先合成完也要等 seq0）", async () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let call = 0;
    const tts: TTSPort = {
      async synthesize() {
        const index = call;
        call += 1;
        const gate = gates[index];
        if (!gate) throw new Error(`意外的 TTS 调用 #${index}`);
        await gate.promise;
        return { mime: "audio/wav", data: Buffer.from([index]) };
      },
    };
    const harness = setup({ llm: scriptedLlm([[rawBeat("第一句"), rawBeat("第二句")]]), tts });
    await harness.hello();

    const turn = harness.input(1, "你好");
    await harness.waitUntil(() => beatsOf(harness.sent, 1).length === 2);

    // seq1 先合成完：仍不能发送，必须等 seq0。
    gates[1]?.resolve();
    await flushMicrotasks();
    expect(ttsSeqs(harness.sent)).toEqual([]);

    gates[0]?.resolve();
    await turn;
    expect(ttsSeqs(harness.sent)).toEqual([0, 1]);
  });

  it("LLM 先结束、TTS 后完成 → turn_end 在最后一个 tts_audio 之后", async () => {
    const gate = Promise.withResolvers<void>();
    const tts: TTSPort = {
      async synthesize() {
        await gate.promise;
        return { mime: "audio/wav", data: Buffer.from([1]) };
      },
    };
    const harness = setup({ llm: scriptedLlm([[rawBeat("一"), rawBeat("二")]]), tts });
    await harness.hello();

    const turn = harness.input(1, "你好");
    await harness.waitUntil(() => beatsOf(harness.sent, 1).length === 2);
    expect(harness.sent.some((message) => message.type === "turn_end")).toBe(false);

    gate.resolve();
    await turn;
    const turnEndIndex = harness.sent.findIndex((message) => message.type === "turn_end");
    const lastTtsIndex = harness.sent.findLastIndex((message) => message.type === "tts_audio");
    expect(lastTtsIndex).toBeGreaterThan(-1);
    expect(turnEndIndex).toBeGreaterThan(lastTtsIndex);
    expect(ttsSeqs(harness.sent)).toEqual([0, 1]);
  });

  it("TTS 全部完成后 LLM 才结束 → turn_end 仍在最后", async () => {
    const release = Promise.withResolvers<void>();
    const llm: LLMPort = {
      async *streamBeats() {
        yield rawBeat("一");
        await release.promise;
        yield rawBeat("二");
      },
    };
    const tts: TTSPort = {
      synthesize() {
        return Promise.resolve({ mime: "audio/wav", data: Buffer.from([1]) });
      },
    };
    const harness = setup({ llm, tts });
    await harness.hello();

    const turn = harness.input(1, "你好");
    await harness.waitUntil(() => ttsSeqs(harness.sent).length === 1);
    expect(harness.sent.some((message) => message.type === "turn_end")).toBe(false);

    release.resolve();
    await turn;
    const turnEndIndex = harness.sent.findLastIndex((message) => message.type === "turn_end");
    expect(turnEndIndex).toBe(harness.sent.length - 1);
    expect(ttsSeqs(harness.sent)).toEqual([0, 1]);
  });
});

describe("session：beats、剧情与错误", () => {
  it("LLM 返回的 seq 被重写为 0,1,2…", async () => {
    const harness = setup({
      llm: scriptedLlm([[rawBeat("一", { seq: 5 }), rawBeat("二", { seq: 5 }), rawBeat("三", { seq: 9 })]]),
    });
    await harness.hello();
    await harness.input(1, "你好");

    expect(harness.sent.flatMap((message) => (message.type === "beat" ? [message.payload.beat.seq] : []))).toEqual([0, 1, 2]);
  });

  it("剧情：跳级被拒绝；合法转移更新 node 与 trust；每轮最多一步", async () => {
    const harness = setup({
      llm: scriptedLlm([
        [rawBeat("跳级", { story: { advance: "reveal" } })],
        [rawBeat("合法", { story: { advance: "probe" } })],
        [rawBeat("一步", { story: { advance: "reveal" } }), rawBeat("再一步", { story: { advance: "ending" } })],
      ]),
    });
    await harness.hello();

    await harness.input(1, "你好");
    expect(beatsOf(harness.sent, 1)[0]).toMatchObject({ payload: { beat: { story: null } } });
    expect(harness.sent.find((message) => message.type === "state_snapshot")?.payload.snapshot).toMatchObject({
      node: "arrive",
      trust: 0,
    });

    await harness.input(2, "你在等谁？");
    expect(harness.sent.filter((message) => message.type === "state_snapshot").at(-1)?.payload.snapshot).toMatchObject({
      node: "probe",
      trust: 1,
    });

    await harness.input(3, "然后呢？");
    expect(harness.sent.filter((message) => message.type === "state_snapshot").at(-1)?.payload.snapshot).toMatchObject({
      node: "reveal",
      trust: 2,
    });
    expect(beatsOf(harness.sent, 3)[0]).toMatchObject({ payload: { beat: { story: { advance: "reveal" } } } });
    expect(beatsOf(harness.sent, 3)[1]).toMatchObject({ payload: { beat: { story: null } } });
  });

  it("LLM 抛出非 AbortError → error{turn_failed} 再 turn_end{error}", async () => {
    const llm: LLMPort = {
      streamBeats() {
        throw new Error("boom");
      },
    };
    const harness = setup({ llm });
    await harness.hello();
    await harness.input(1, "你好");

    const errorIndex = harness.sent.findIndex((message) => message.type === "error");
    const turnEndIndex = harness.sent.findIndex((message) => message.type === "turn_end");
    expect(harness.sent[errorIndex]).toMatchObject({
      type: "error",
      turnId: 1,
      payload: { code: "turn_failed", message: "boom", retryable: true },
    });
    expect(harness.sent[turnEndIndex]).toMatchObject({ type: "turn_end", payload: { reason: "error" } });
    expect(turnEndIndex).toBeGreaterThan(errorIndex);
  });
});

describe("session：interrupt 与会话恢复", () => {
  it("interrupt 只中止对应的轮次；不匹配时忽略", async () => {
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const llm: LLMPort = {
      async *streamBeats(_ctx, signal) {
        calls += 1;
        const thisCall = calls;
        yield rawBeat("一");
        if (thisCall === 1) {
          await release.promise;
          yield rawBeat("二");
          return;
        }
        await untilAborted(signal).catch(() => undefined);
        yield rawBeat("二");
      },
    };
    const harness = setup({ llm });
    await harness.hello();

    const first = harness.input(1, "开始");
    await harness.waitUntil(() => beatsOf(harness.sent, 1).length > 0);
    await harness.interrupt(1, 99);
    release.resolve();
    await first;
    expect(beatsOf(harness.sent, 1)).toHaveLength(2);
    expect(harness.sent.find((message) => message.type === "turn_end")?.payload).toEqual({ reason: "done" });

    const second = harness.input(2, "再来");
    await harness.waitUntil(() => beatsOf(harness.sent, 2).length > 0);
    const marker = harness.sent.length;
    await harness.interrupt(2, 2);
    await second;
    expect(harness.sent.slice(marker).filter((message) => message.turnId === 2)).toEqual([]);
    expect(beatsOf(harness.sent, 2)).toHaveLength(1);
    expect(turnEndsOf(harness.sent, 2)).toEqual([]);
  });

  it("hello 带已有 sessionId → 返回同一份 scene", async () => {
    const harness = setup({ llm: scriptedLlm([[rawBeat("合法", { story: { advance: "probe" } })]]) });
    const first = await harness.hello();
    await harness.input(1, "你在等谁？");
    const snapshot = harness.sent.filter((message) => message.type === "state_snapshot").at(-1);
    expect(snapshot?.payload.snapshot).toMatchObject({ node: "probe", trust: 1, turnCount: 1 });

    const resumed = await harness.hello(first.sessionId);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.payload.snapshot).toEqual(snapshot?.payload.snapshot);
  });
});

describe("session：音频输入", () => {
  it("audio_input → 先发 transcript，再进入 beat 流程", async () => {
    const stt: STTPort = {
      transcribe() {
        return Promise.resolve("你在等谁？");
      },
    };
    const harness = setup({ stt, llm: scriptedLlm([[rawBeat("我在等人。")]]) });
    await harness.hello();
    await harness.audio(1);

    expect(harness.sent.map((message) => message.type)).toEqual([
      "session",
      "transcript",
      "beat",
      "tts_audio",
      "state_snapshot",
      "turn_end",
    ]);
    expect(harness.sent.find((message) => message.type === "transcript")?.payload).toEqual({ text: "你在等谁？" });
  });
});
