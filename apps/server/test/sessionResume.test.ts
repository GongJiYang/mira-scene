/**
 * S6l-fix1 §1：刷新恢复——`session` 消息带 background 与 transcript。
 *
 * 覆盖：
 * - 换背景成功 → 同 sessionId 重新 hello → session.background 的 label/urls 与 ready 时一致；
 * - transcript 与 history 一致（user / assistant 原样）；
 * - 新会话 → background: null、transcript: []；
 * - transcript 超过 40 条时只保留最近 40 条。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { silentLogger } from "../src/log";
import type { LLMPort, STTPort, TTSPort } from "../src/ports";
import { createMockSceneWriter } from "../src/adapters/mock/mockSceneWriter";
import { createSessionManager, resumePayload, TRANSCRIPT_LIMIT, type SendFn, type SessionManager } from "../src/session";
import { testPacks } from "./helpers/pack";

const immediateStt: STTPort = { transcribe: () => Promise.resolve("你好") };
const immediateTts: TTSPort = { synthesize: () => Promise.resolve({ mime: "audio/wav", data: Buffer.from([1]) }) };

let outDirs: string[] = [];
let active: SessionManager | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
  outDirs = [];
});

function tempOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "s6l-fix1-resume-"));
  outDirs.push(dir);
  return dir;
}

function okResponse(): Response {
  const onePx =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";
  return new Response(JSON.stringify({ data: [{ b64_json: onePx }] }), { status: 200 });
}

/** 按顺序消费脚本：每轮取一组 beat。 */
function scriptedLlm(scripts: Array<Array<{ say: string }>>): LLMPort {
  const pending = [...scripts];
  return {
    async *streamBeats() {
      yield* (pending.shift() ?? [{ say: "嗯。" }]);
    },
  };
}

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  hello(resumeSessionId?: string): Promise<Extract<ServerMessage, { type: "session" }>>;
  input(turnId: number, text: string): Promise<void>;
};

function setup(scripts: Array<Array<{ say: string }>>): Harness {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const manager = createSessionManager({
    stt: immediateStt,
    llm: scriptedLlm(scripts),
    tts: immediateTts,
    packs: testPacks(),
    log: silentLogger,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    sceneWriter: createMockSceneWriter(),
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
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

  return {
    manager,
    sent,
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

describe("刷新恢复：session 带 background / transcript（S6l-fix1 §1）", () => {
  it("换背景成功 → 恢复时 background 的 label/urls 与 ready 一致", async () => {
    const harness = setup([[{ say: "嗯。" }]]);
    const first = await harness.hello();
    await harness.input(1, "换背景到海边");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ready = harness.sent.find((m) => m.type === "scene_status" && m.payload.status === "ready");
    expect(ready?.type).toBe("scene_status");

    const resumed = await harness.hello(first.sessionId);
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(resumed.payload.background).toEqual({
      label: "黄昏海边",
      urls: { desktop: expect.stringMatching(/^\/generated\//), mobile: expect.stringMatching(/^\/generated\//) },
    });
    if (ready?.type === "scene_status") {
      expect(resumed.payload.background?.urls).toEqual(ready.payload.urls);
    }
  });

  it("恢复时 transcript 与 history 一致（user / assistant 原样，assistant 多句按换行保留）", async () => {
    const harness = setup([[{ say: "嗯。" }, { say: "也在。" }]]);
    const first = await harness.hello();
    await harness.input(1, "你好");
    // assistant 的 says 用换行拼起来。
    const resumed = await harness.hello(first.sessionId);
    expect(resumed.payload.transcript).toEqual([
      { role: "user", text: "你好" },
      { role: "assistant", text: "嗯。\n也在。" },
    ]);
  });

  it("新会话 → background: null、transcript: []", async () => {
    const harness = setup([[{ say: "嗯。" }]]);
    const session = await harness.hello();
    expect(session.payload.background).toBeNull();
    expect(session.payload.transcript).toEqual([]);
  });

  it("§5.1：session 带 startedAt；恢复会话沿用原值", async () => {
    const harness = setup([[{ say: "嗯。" }]]);
    const first = await harness.hello();
    expect(typeof first.payload.startedAt).toBe("number");
    const startedAt = first.payload.startedAt;
    const resumed = await harness.hello(first.sessionId);
    expect(resumed.payload.startedAt).toBe(startedAt);
  });

  it("transcript 超过 40 条时只保留最近 40 条（纯函数）", async () => {
    const history = Array.from({ length: 50 }, (_, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `第 ${index} 条`,
    }));
    const { transcript } = resumePayload({ sceneJob: {}, history });
    expect(transcript).toHaveLength(TRANSCRIPT_LIMIT);
    expect(transcript[0]?.text).toBe("第 10 条");
    expect(transcript.at(-1)?.text).toBe("第 49 条");
  });

  it("S6l-fix2 §7：transcript 不含 nudge / poke / gift 占位（assistant 照旧）", () => {
    const history = [
      { role: "user" as const, text: "（客人安静地坐着，没有说话）", source: "nudge" as const },
      { role: "assistant" as const, text: "……" },
      { role: "user" as const, text: "（观众做出了一个动作，没有说话）", source: "poke" as const },
      { role: "assistant" as const, text: "干嘛戳我。" },
      { role: "user" as const, text: "你好" },
      { role: "assistant" as const, text: "嗯。" },
    ];
    const { transcript } = resumePayload({ sceneJob: {}, history });
    expect(transcript).toEqual([
      { role: "assistant", text: "……" },
      { role: "assistant", text: "干嘛戳我。" },
      { role: "user", text: "你好" },
      { role: "assistant", text: "嗯。" },
    ]);
  });
});
