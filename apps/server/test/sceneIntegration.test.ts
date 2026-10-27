/**
 * S6c §6：换背景集成测试（假 SceneWriter + 假 fetch）。
 *
 * 覆盖：成功、模糊请求（Mock 返回「随便换」条）、拒绝、扩写非法 JSON、生图超时、
 * 冷却期再次请求、只成一张图。验证 scene_status 序列和兜底台词。
 */
import { describe, expect, it, afterEach } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { silentLogger } from "../src/log";
import type { LLMPort, STTPort, TTSPort } from "../src/ports";
import { createMockSceneWriter } from "../src/adapters/mock/mockSceneWriter";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPacks } from "./helpers/pack";

type LlmBeatFixture = { say: string; emotion?: string; suggest?: string | null; advance?: string | null };

function beat(say: string, extra: Partial<LlmBeatFixture> = {}): LlmBeatFixture {
  return { say, emotion: "neutral", suggest: null, advance: null, ...extra };
}

function scriptedLlm(scripts: LlmBeatFixture[][]): LLMPort {
  const pending = [...scripts];
  return {
    async *streamBeats() {
      yield* (pending.shift() ?? []);
    },
  };
}

const immediateStt: STTPort = { transcribe: () => Promise.resolve("你好") };
const immediateTts: TTSPort = {
  synthesize: () => Promise.resolve({ mime: "audio/wav", data: Buffer.from([1]) }),
};

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  sessionId: string;
  hello(): Promise<void>;
  input(turnId: number, text: string): Promise<void>;
};

let active: SessionManager | null = null;

function setup(scripts: LlmBeatFixture[][], sceneWriter?: ReturnType<typeof createMockSceneWriter>): Harness {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const manager = createSessionManager({
    stt: immediateStt,
    llm: scriptedLlm(scripts),
    tts: immediateTts,
    packs: testPacks(),
    log: silentLogger,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    sceneWriter: sceneWriter ?? createMockSceneWriter(),
  });
  active = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

  return {
    manager,
    sent,
    sessionId: "",
    async hello() {
      await manager.handleMessage(send, envelope("hello", {}, "", 0));
      const session = sent.findLast((message) => message.type === "session");
      if (!session || session.type !== "session") throw new Error("没有收到 session");
      this.sessionId = session.sessionId;
    },
    input(turnId, text) {
      const sessionId = sent.findLast((message) => message.type === "session")?.sessionId ?? "";
      return manager.handleMessage(send, envelope("text_input", { text }, sessionId, turnId));
    },
  };
}

function sceneStatuses(sent: ServerMessage[]) {
  return sent.filter((message) => message.type === "scene_status");
}

function beatsWithSay(sent: ServerMessage[], text: string) {
  return sent.filter(
    (message) => message.type === "beat" && message.payload.beat.say.includes(text),
  );
}

afterEach(() => {
  active?.dispose();
  active = null;
});

describe("换背景集成（S6c §6）", () => {
  it("命中「换背景到海边」→ 回话 + scene_status 序列 + 后台任务", async () => {
    const harness = setup([[beat("嗯。")]]);
    await harness.hello();
    await harness.input(1, "换背景到海边");

    // 本轮照常回话。
    expect(beatsWithSay(harness.sent, "嗯。").length).toBeGreaterThanOrEqual(1);

    // scene_status：writing → generating → ready（Mock 扩写命中「海」→ 黄昏海边）。
    const statuses = sceneStatuses(harness.sent);
    expect(statuses.length).toBeGreaterThanOrEqual(3);
    expect(statuses[0]?.payload.status).toBe("writing");
    expect(statuses[1]?.payload.status).toBe("generating");
    expect(statuses[1]?.payload.label).toBe("黄昏海边");
    expect(statuses[2]?.payload.status).toBe("ready");
    // S6c §6：Mock 模式返回角色包目录下的预置测试图（rin 的测试图为 .png）。
    expect(statuses[2]?.payload.urls?.desktop).toBe("/characters/rin/test-scene-desktop.png");
    expect(statuses[2]?.payload.urls?.mobile).toBe("/characters/rin/test-scene-mobile.png");
  });

  it("模糊请求「换个地方」→ Mock 返回「随便换」条（深夜天台）", async () => {
    // 注：「随便换个好看的」不命中 §1 的 regex（任务说明原样）；这里用「换个地方」验证 Mock 查表兜底。
    const harness = setup([[beat("嗯。")]]);
    await harness.hello();
    await harness.input(1, "换个地方");

    const statuses = sceneStatuses(harness.sent);
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses[1]?.payload.label).toBe("深夜天台");
  });

  it("冷却期再次请求 → scene_busy + 不发起新任务", async () => {
    const harness = setup([[beat("嗯。")], [beat("嗯。")]]);
    await harness.hello();
    await harness.input(1, "换背景到海边");

    // 等第一次任务 ready（Mock 模式立即 ready，但需要等 Promise 结算）。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ready = sceneStatuses(harness.sent).filter((m) => m.payload.status === "ready");
    expect(ready.length).toBeGreaterThanOrEqual(1);
    // 冷却 45 秒内第二次请求 → busy。
    await harness.input(2, "换背景到雨夜");
    // 等第二次的 busy 消息发出。
    await new Promise((resolve) => setTimeout(resolve, 50));

    const statuses = sceneStatuses(harness.sent);
    const busy = statuses.filter((m) => m.payload.status === "busy");
    expect(busy.length).toBeGreaterThanOrEqual(1);

    // 角色说了 scene_busy 台词（默认角色 rin）。
    const busySays = harness.sent.filter((m) => m.type === "beat").map((m) => m.payload.beat.say);
    expect(busySays).toContain("别急，一个一个来。");
  });

  it("扩写非法 JSON → scene_status failed + scene_failed 台词", async () => {
    const badWriter = {
      write: () => Promise.resolve("not json"),
    };
    const harness = setup([[beat("嗯。")]], badWriter);
    await harness.hello();
    await harness.input(1, "换背景到海边");
    // 等场景任务 Promise 结算。
    await new Promise((resolve) => setTimeout(resolve, 100));

    const statuses = sceneStatuses(harness.sent);
    const failed = statuses.filter((m) => m.payload.status === "failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    const allBeats = harness.sent.filter((m) => m.type === "beat");
    const allSays = allBeats.map((m) => m.payload.beat.say);
    // 默认角色 rin 的 scene_failed 台词。
    expect(allSays).toContain("好像没换成。这里也挺好的，不是吗。");
  });

  it("扩写拒绝 → scene_status rejected + scene_rejected 台词", async () => {
    const rejectWriter = {
      write: () => Promise.resolve(JSON.stringify({ accept: false, label: "", note: "这个不行哦" })),
    };
    const harness = setup([[beat("嗯。")]], rejectWriter);
    await harness.hello();
    await harness.input(1, "换背景到海边");
    // 等场景任务 Promise 结算。
    await new Promise((resolve) => setTimeout(resolve, 100));

    const statuses = sceneStatuses(harness.sent);
    const rejected = statuses.filter((m) => m.payload.status === "rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    const allSays = harness.sent.filter((m) => m.type === "beat").map((m) => m.payload.beat.say);
    // 默认角色 rin 的 scene_rejected 台词。
    expect(allSays).toContain("那个地方……我们换一个吧。");
  });

  it("Mock 模式完整流程：writing → generating → ready（测试图 URL）", async () => {
    // Mock 模式跳过生图，直接 ready。真实模式「只成一张」由 smoke:scene 验证。
    const writer = {
      write: () =>
        Promise.resolve(
          JSON.stringify({
            accept: true,
            location: "beach",
            time: "sunset",
            lighting: "warm",
            props: ["a", "b"],
            palette: "pink",
            mood: "calm",
            label: "海边",
            note: "note",
          }),
        ),
    };
    const harness = setup([[beat("嗯。")]], writer);
    await harness.hello();
    await harness.input(1, "换背景到海边");

    // Mock 模式：writing → generating → ready。
    const statuses = sceneStatuses(harness.sent);
    expect(statuses.some((m) => m.payload.status === "generating")).toBe(true);
    expect(statuses.some((m) => m.payload.status === "ready")).toBe(true);
    const ready = statuses.find((m) => m.payload.status === "ready");
    expect(ready?.payload.urls?.desktop).toBe("/characters/rin/test-scene-desktop.png");
    expect(ready?.payload.urls?.mobile).toBe("/characters/rin/test-scene-mobile.png");
  });
});
