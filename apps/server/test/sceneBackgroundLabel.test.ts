/**
 * S6l-fix2 §5：当前背景名持久化。
 *
 * 现状：`sceneJob.lastReadyLabel` 同时是「下一轮提示一次」与「当前背景描述」，
 * 提示用完置 undefined 后当前背景名丢失。
 *
 * 修法：拆成 `pendingReadyNote`（一次性，用完清空）与 `currentBackground`（持久）。
 * 断言：
 * - 换背景成功 → 下一轮 scene_notes 含「背景已经换成 X」→ 再下一轮不含；
 * - 第二次换背景时扩写器收到的 currentScene 仍是 X；
 * - 刷新恢复的 background.label 仍是 X。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { silentLogger } from "../src/log";
import type { LLMContext, LLMPort, STTPort, TTSPort } from "../src/ports";
import { createMockSceneWriter } from "../src/adapters/mock/mockSceneWriter";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPacks } from "./helpers/pack";

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: ONE_PX_PNG }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const immediateStt: STTPort = { transcribe: () => Promise.resolve("你好") };
const immediateTts: TTSPort = { synthesize: () => Promise.resolve({ mime: "audio/wav", data: Buffer.from([1]) }) };

/** 捕获每轮传给 LLM 的上下文（看 scene_notes / currentScene）。 */
function capturingLlm(): { port: LLMPort; contexts: LLMContext[] } {
  const contexts: LLMContext[] = [];
  const port: LLMPort = {
    async *streamBeats(ctx) {
      contexts.push(ctx);
      yield { say: "嗯。" };
    },
  };
  return { port, contexts };
}

let outDirs: string[] = [];
let active: SessionManager | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
  outDirs = [];
});

function tempOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "s6l-fix2-bg-"));
  outDirs.push(dir);
  return dir;
}

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  contexts: LLMContext[];
  seenCurrentScene: string[];
  hello(resumeSessionId?: string): Promise<Extract<ServerMessage, { type: "session" }>>;
  input(turnId: number, text: string): Promise<void>;
  advanceClock(ms: number): void;
};

function setup(): Harness {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  let nowMs = 1_000_000;
  const { port, contexts } = capturingLlm();
  const seenCurrentScene: string[] = [];

  // 包装 mock 扩写器，记录 currentScene。
  const inner = createMockSceneWriter();
  const sceneWriter = {
    async write(ctx: Parameters<typeof inner.write>[0], signal: AbortSignal) {
      seenCurrentScene.push(ctx.currentScene);
      return inner.write(ctx, signal);
    },
  };

  const manager = createSessionManager({
    stt: immediateStt,
    llm: port,
    tts: immediateTts,
    packs: testPacks(),
    log: silentLogger,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    now: () => nowMs,
    sceneWriter,
    sceneImageGen: {
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      model: "gpt-image-test",
      outDir: tempOutDir(),
      fetchImpl: (async () => okResponse()) as typeof fetch,
    },
  });
  active = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: nowMs, type, payload }) as ClientMessage;

  return {
    manager,
    sent,
    contexts,
    seenCurrentScene,
    advanceClock: (ms) => void (nowMs += ms),
    async hello(resumeSessionId) {
      await manager.handleMessage(send, envelope("hello", { resumeSessionId }, resumeSessionId ?? "", 0));
      const message = sent.findLast((m) => m.type === "session");
      if (!message || message.type !== "session") throw new Error("没有收到 session");
      return message;
    },
    input(turnId, text) {
      const sessionId = sent.findLast((m) => m.type === "session")?.sessionId ?? "";
      return manager.handleMessage(send, envelope("text_input", { text }, sessionId, turnId));
    },
  };
}

/** 从上下文取出给 LLM 的 scene_notes（dynamicTemplate 填充后的字符串里含它）。 */
function sceneNotesOf(ctx: LLMContext): string {
  return ctx.sceneNotes ?? "";
}

describe("当前背景名持久化（S6l-fix2 §5）", () => {
  it("换背景成功 → 下一轮含「背景已经换成 X」，再下一轮不含", async () => {
    const harness = setup();
    await harness.hello();

    // 第 1 轮：触发换背景（含「海」→ 黄昏海边）。
    await harness.input(1, "换背景到海边");
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 第 2 轮：应带一次性提示。
    harness.advanceClock(50_000);
    await harness.input(2, "嗯嗯");
    // 第 3 轮：提示已用完，不再带。
    await harness.input(3, "然后呢");

    expect(sceneNotesOf(harness.contexts[1]!)).toContain("背景已经换成 黄昏海边");
    expect(sceneNotesOf(harness.contexts[2]!)).not.toContain("背景已经换成");
  });

  it("第二次换背景时扩写器收到的 currentScene 仍是上一次换成的背景名", async () => {
    const harness = setup();
    await harness.hello();

    await harness.input(1, "换背景到海边");
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 第 2 轮：让一次性提示被用掉（当前背景名不应随之丢失）。
    harness.advanceClock(50_000);
    await harness.input(2, "嗯嗯");
    // 第 3 轮：第二次换背景。
    harness.advanceClock(50_000);
    await harness.input(3, "换背景到海边 2");

    // 两次扩写的 currentScene：第一次是默认场景描述，第二次必须是「黄昏海边」（不是节点 label）。
    expect(harness.seenCurrentScene[0]).not.toBe("黄昏海边");
    expect(harness.seenCurrentScene[1]).toBe("黄昏海边");
  });

  it("刷新恢复的 background.label 仍是当前背景名（提示已用掉后）", async () => {
    const harness = setup();
    const first = await harness.hello();

    await harness.input(1, "换背景到海边");
    await new Promise((resolve) => setTimeout(resolve, 100));
    harness.advanceClock(50_000);
    await harness.input(2, "嗯嗯");

    const resumed = await harness.hello(first.sessionId);
    expect(resumed.payload.background?.label).toBe("黄昏海边");
  });
});
