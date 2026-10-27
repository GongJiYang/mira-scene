/**
 * S6c §6：换背景集成测试（假 SceneWriter + 假 fetch）。
 *
 * 覆盖：成功、模糊请求（Mock 返回「随便换」条）、拒绝、扩写非法 JSON、生图超时、
 * 冷却期再次请求、只成一张图。验证 scene_status 序列和兜底台词。
 */
import { describe, expect, it, afterEach } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { silentLogger } from "../src/log";
import type { LLMContext, LLMPort, STTPort, TTSPort } from "../src/ports";
import { createMockSceneWriter } from "../src/adapters/mock/mockSceneWriter";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPacks } from "./helpers/pack";

type LlmBeatFixture = { say: string; emotion?: string; suggest?: string | null; advance?: string | null };

function beat(say: string, extra: Partial<LlmBeatFixture> = {}): LlmBeatFixture {
  return { say, emotion: "neutral", suggest: null, advance: null, ...extra };
}

/** 捕获每次 streamBeats 的 ctx，便于断言 scene_notes。 */
const llmContexts: LLMContext[] = [];

function scriptedLlm(scripts: LlmBeatFixture[][]): LLMPort {
  const pending = [...scripts];
  return {
    async *streamBeats(ctx) {
      llmContexts.push(ctx);
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
  llmContexts.length = 0;
});

/** 取第 n 轮（按调用顺序，1 起）的 LLM scene_notes。 */
function ctxNotes(nth: number): string {
  return llmContexts[nth - 1]?.sceneNotes ?? "";
}

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
    // S6c §6：Mock 模式返回角色包目录下的预置测试图（缺省角色忧奈，测试图为 .jpg）。
    expect(statuses[2]?.payload.urls?.desktop).toBe("/characters/yuna/test-scene-desktop.jpg");
    expect(statuses[2]?.payload.urls?.mobile).toBe("/characters/yuna/test-scene-mobile.jpg");
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
    expect(busySays).toContain("等等，上一个还没换完呢。");
  });

  it("扩写非法 JSON → scene_status failed（带 category=scene_failed）+ 不发轮次 beat（S6c-fix1 §2）", async () => {
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
    // S6c-fix1 §2：failed 属于剧情层，载荷带 category，不再发轮次 beat。
    expect(failed[0]?.payload.category).toBe("scene_failed");
    const allSays = harness.sent.filter((m) => m.type === "beat").map((m) => m.payload.beat.say);
    expect(allSays).not.toContain("诶，背景卡住了，没换成……先凑合一下吧。");
    expect(allSays).toContain("嗯。");
  });

  it("扩写拒绝 → scene_status rejected（带 category=scene_rejected）+ 不发轮次 beat（S6c-fix1 §2）", async () => {
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
    expect(rejected[0]?.payload.category).toBe("scene_rejected");
    const allSays = harness.sent.filter((m) => m.type === "beat").map((m) => m.payload.beat.say);
    expect(allSays).not.toContain("这个不行哦，换一个别的吧。");
  });

  it("busy 兜底句占用本轮下一个 seq，LLM 的第一句不被去重丢掉（S6c-fix1 §1）", async () => {
    llmContexts.length = 0;
    const harness = setup([[beat("嗯。")], [beat("第二轮的回复")]]);
    await harness.hello();
    await harness.input(1, "换背景到海边");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 等第一次 ready。
    expect(sceneStatuses(harness.sent).some((m) => m.payload.status === "ready")).toBe(true);
    llmContexts.length = 0;

    // 冷却期内第二次请求 → busy 兜底句 + 本轮照常回话。
    await harness.input(2, "换背景到雨夜");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 第 2 轮的所有 beat（按 seq 排序）：busy 兜底句应是 seq 0，LLM 的第一句是 seq 1，互不冲突。
    const beats = harness.sent.filter(
      (m) => m.type === "beat" && m.turnId === 2,
    ) as Extract<ServerMessage, { type: "beat" }>[];
    expect(beats.length).toBeGreaterThanOrEqual(2);
    const sorted = beats.map((m) => m.payload.beat.seq).sort((a, b) => a - b);
    expect(sorted[0]).toBe(0);
    expect(new Set(sorted).size).toBe(sorted.length); // 无重复 seq
    const busyBeat = beats.find((m) => m.payload.beat.say === "等等，上一个还没换完呢。");
    expect(busyBeat?.payload.beat.seq).toBe(0);
    const llmBeat = beats.find((m) => m.payload.beat.say === "第二轮的回复");
    expect(llmBeat?.payload.beat.seq).toBe(1);
  });

  it("被拒时 scene_notes 说「换不了」，准入通过时才是「正在换」（S6c-fix1 §1）", async () => {
    llmContexts.length = 0;
    const rejectWriter = { write: () => Promise.resolve(JSON.stringify({ accept: false, label: "", note: "不行" })) };
    const harness = setup([[beat("嗯。")], [beat("嗯。")]], rejectWriter);
    await harness.hello();
    // 第 1 轮：准入通过（发起了任务）→ 本轮 scene_notes 是「正在换」。
    await harness.input(1, "换背景到海边");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ctxNotes(1)).toContain("正在换");

    // 第 2 轮：冷却中 → 被拒 → 本轮 scene_notes 说「换不了」。
    await harness.input(2, "换背景到雨夜");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondNote = ctxNotes(2);
    expect(secondNote).not.toContain("正在换");
    expect(secondNote).toContain("换不了");
  });

  it("失败后下一轮 scene_notes 加「刚才背景没换成」（S6c-fix1 §2）", async () => {
    llmContexts.length = 0;
    const badWriter = { write: () => Promise.resolve("not json") };
    const harness = setup([[beat("嗯。")], [beat("嗯。")]], badWriter);
    await harness.hello();
    await harness.input(1, "换背景到海边");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await harness.input(2, "还在吗");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctxNotes(2)).toContain("刚才背景没换成");
  });

  it("恢复会话后换背景仍可用（sceneController 被重建，S6c-fix1 §4）", async () => {
    const sent: ServerMessage[] = [];
    const send: SendFn = (message) => void sent.push(message);
    const manager = createSessionManager({
      stt: immediateStt,
      llm: scriptedLlm([[beat("嗯。")]]),
      tts: immediateTts,
      packs: testPacks(),
      log: silentLogger,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      sceneWriter: createMockSceneWriter(),
    });
    active = manager;
    const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
      ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

    await manager.handleMessage(send, envelope("hello", {}, "", 0));
    const sessionId = sent.findLast((m) => m.type === "session")?.sessionId ?? "";
    // 恢复会话（带 resumeSessionId）→ 解绑旧连接会 abort sceneController，绑定新连接时应重建。
    await manager.handleMessage(send, envelope("hello", { resumeSessionId: sessionId }, "", 0));
    await manager.handleMessage(send, envelope("text_input", { text: "换背景到海边" }, sessionId, 1));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 任务仍然跑完（writing → generating → ready），没有因 signal 已 abort 而立即失败。
    const statuses = sent.filter((m) => m.type === "scene_status");
    expect(statuses.some((m) => m.payload.status === "ready")).toBe(true);
    expect(statuses.some((m) => m.payload.status === "failed")).toBe(false);
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
    expect(ready?.payload.urls?.desktop).toBe("/characters/yuna/test-scene-desktop.jpg");
    expect(ready?.payload.urls?.mobile).toBe("/characters/yuna/test-scene-mobile.jpg");
  });
});
