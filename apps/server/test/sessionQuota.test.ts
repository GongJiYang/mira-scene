import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { createMockLlm } from "../src/adapters/mock/mockLlm";
import { createMockStt } from "../src/adapters/mock/mockStt";
import { createMockTts } from "../src/adapters/mock/mockTts";
import { silentLogger } from "../src/log";
import type { LLMContext, LLMPort } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPacksWithRinVisible } from "./helpers/pack";

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  llmCalls: () => number;
  hello(): Promise<string>;
  input(turnId: number, text: string): Promise<void>;
};

let activeManager: SessionManager | null = null;

afterEach(() => {
  activeManager?.dispose();
  activeManager = null;
});

function setup(options: {
  sessionTurnLimit: number;
  dailyTurnLimit: number;
  now?: () => number;
}): Harness {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => {
    sent.push(message);
  };
  let calls = 0;
  const mock = createMockLlm({ beatDelayMs: 0 });
  const llm: LLMPort = {
    streamBeats(ctx: LLMContext, signal: AbortSignal) {
      calls += 1;
      return mock.streamBeats(ctx, signal);
    },
  };
  const manager = createSessionManager({
    stt: createMockStt({ delayMs: 0 }),
    llm,
    tts: createMockTts({ delayMs: 0 }),
    packs: testPacksWithRinVisible(),
    log: silentLogger,
    sessionTurnLimit: options.sessionTurnLimit,
    dailyTurnLimit: options.dailyTurnLimit,
    now: options.now,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
  });
  activeManager = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

  const harness: Harness = {
    manager,
    sent,
    llmCalls: () => calls,
    async hello() {
      await manager.handleMessage(send, envelope("hello", {}, "", 0));
      const session = sent.findLast((message) => message.type === "session");
      if (!session || session.type !== "session") throw new Error("没有收到 session");
      return session.sessionId;
    },
    async input(turnId, text) {
      const sessionId = sent.findLast((message) => message.type === "session")?.sessionId ?? "";
      await manager.handleMessage(send, envelope("text_input", { text }, sessionId, turnId));
    },
  };
  return harness;
}

function quotaErrors(sent: ServerMessage[], turnId: number) {
  return sent.filter(
    (message): message is Extract<ServerMessage, { type: "error" }> =>
      message.type === "error" && message.turnId === turnId,
  );
}

describe("会话限额（Q12）", () => {
  it("每会话 2 轮：第 3 轮返回 quota_exceeded，且不调用 Provider", async () => {
    const harness = setup({ sessionTurnLimit: 2, dailyTurnLimit: 100 });
    await harness.hello();

    await harness.input(1, "第一轮");
    await harness.input(2, "第二轮");
    expect(harness.llmCalls()).toBe(2);

    await harness.input(3, "第三轮");
    const errors = quotaErrors(harness.sent, 3);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.payload).toMatchObject({ code: "quota_exceeded", retryable: false });
    expect(harness.llmCalls()).toBe(2);
    expect(harness.sent.some((message) => message.type === "beat" && message.turnId === 3)).toBe(false);
    expect(harness.sent.some((message) => message.type === "turn_end" && message.turnId === 3)).toBe(false);
  });

  it("全站每日 2 轮：跨会话累计，超出后新会话也被拒", async () => {
    const harness = setup({ sessionTurnLimit: 30, dailyTurnLimit: 2 });

    await harness.hello();
    await harness.input(1, "第一轮");
    await harness.input(2, "第二轮");

    await harness.hello();
    await harness.input(1, "新会话第一轮");
    const errors = quotaErrors(harness.sent, 1);
    expect(errors.at(-1)?.payload).toMatchObject({ code: "quota_exceeded", retryable: false });
    expect(harness.llmCalls()).toBe(2);
  });

  it("每日计数按自然日重置", async () => {
    let now = new Date(2026, 9, 26, 23, 0, 0).getTime();
    const harness = setup({ sessionTurnLimit: 30, dailyTurnLimit: 1, now: () => now });

    await harness.hello();
    await harness.input(1, "今天的一轮");
    expect(harness.llmCalls()).toBe(1);

    await harness.hello();
    await harness.input(1, "今天超额");
    expect(quotaErrors(harness.sent, 1)).toHaveLength(1);
    expect(harness.llmCalls()).toBe(1);

    // 跨自然日（本地时区）：限额归零。
    now = new Date(2026, 9, 27, 0, 5, 0).getTime();
    await harness.hello();
    await harness.input(1, "第二天");
    expect(harness.llmCalls()).toBe(2);
    expect(harness.sent.filter((message) => message.type === "turn_end")).toHaveLength(2);
  });

  it("stale_turn 优先于限额判定（重复 turnId 仍回报 stale_turn）", async () => {
    const harness = setup({ sessionTurnLimit: 1, dailyTurnLimit: 100 });
    await harness.hello();
    await harness.input(1, "唯一一轮");
    await harness.input(1, "重复");
    expect(quotaErrors(harness.sent, 1).at(-1)?.payload).toMatchObject({ code: "stale_turn" });
  });
});
