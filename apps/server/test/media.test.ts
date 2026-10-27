import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { createPresetMedia, DEFAULT_PRESET_DELAY_MS } from "../src/adapters/media/presetMedia";
import { silentLogger } from "../src/log";
import type { LLMPort, MediaContext, STTPort, TTSPort } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPack, testPacksWithRinVisible } from "./helpers/pack";

type LlmBeatFixture = { say: string; emotion?: string; suggest?: string | null; advance?: string | null };

function beat(say: string, extra: Partial<LlmBeatFixture> = {}): LlmBeatFixture {
  return { say, emotion: "neutral", suggest: null, advance: null, ...extra };
}

/** 按顺序消费脚本：每次 streamBeats 取下一个脚本。 */
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
// S6b-fix1 §4：直接调用 preset 时的最小上下文（presetMedia 忽略它）。
const CTX: MediaContext = { pack: testPack("rin"), history: [] };

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  sessionId: string;
  hello(): Promise<void>;
  input(turnId: number, text: string): Promise<void>;
};

let active: SessionManager | null = null;

function setup(scripts: LlmBeatFixture[][], mediaDelayMs = DEFAULT_PRESET_DELAY_MS): Harness {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const manager = createSessionManager({
    stt: immediateStt,
    llm: scriptedLlm(scripts),
    tts: immediateTts,
    media: createPresetMedia({ delayMs: mediaDelayMs }),
    packs: testPacksWithRinVisible(),
    log: silentLogger,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
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

const ENTER_REVEAL: LlmBeatFixture[] = [
  beat("他第一封信里说，不敢打电话。", { emotion: "sad", suggest: "show_polaroid", advance: "reveal" }),
];

function mediaBeats(sent: ServerMessage[]) {
  return sent.flatMap((message) => (message.type === "beat" && message.payload.beat.media ? [message.payload.beat.media] : []));
}

function mediaReady(sent: ServerMessage[]) {
  return sent.filter((message) => message.type === "media_ready");
}

afterEach(() => {
  active?.dispose();
  active = null;
});

describe("presetMedia 适配器（D27）", () => {
  it("默认 2.5s 后返回 /stage/photos/<id>.png，status=ready", async () => {
    const port = createPresetMedia();
    const started = Date.now();
    const result = await port.preset({ type: "photo", id: "photo_letters" }, CTX, new AbortController().signal);
    expect(result).toEqual({ url: "/stage/photos/photo_letters.png", status: "ready" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEFAULT_PRESET_DELAY_MS - 50);
  });

  it("signal 中止时以 AbortError 结束，不产出结果", async () => {
    const port = createPresetMedia({ delayMs: 1_000 });
    const controller = new AbortController();
    const pending = port.preset({ type: "photo", id: "x" }, CTX, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("剧情层媒体：beat 带 storyEventId 与 media_ready（D27）", () => {
  it("带 media 的 beat 携带 <sessionId>:<turn>:<seq>，延迟后才下发 media_ready", async () => {
    const harness = setup([[beat("我在等人。", { advance: "probe" })], ENTER_REVEAL], 2_500);
    await harness.hello();
    await harness.input(1, "你在等谁？");
    await harness.input(2, "然后呢");

    const media = mediaBeats(harness.sent);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ type: "photo", id: "photo_letters" });
    expect(media[0]?.storyEventId).toBe(`${harness.sessionId}:2:0`);
    // beat 本身不带 url（url 由 media_ready 给出）。
    expect(media[0]?.url).toBeUndefined();

    // 还没到 2.5s：只有排期日志，没有下发。
    expect(mediaReady(harness.sent)).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 2_600));
    const ready = mediaReady(harness.sent);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.payload).toEqual({
      storyEventId: `${harness.sessionId}:2:0`,
      media: { type: "photo", id: "photo_letters", url: "/stage/photos/photo_letters.png" },
      status: "ready",
    });
  }, 10_000);

  it("打断（新一轮）后，media_ready 仍然送达（有意为之的例外）", async () => {
    const harness = setup([[beat("我在等人。", { advance: "probe" })], ENTER_REVEAL, [beat("嗯。")]], 300);
    await harness.hello();
    await harness.input(1, "你在等谁？");
    await harness.input(2, "然后呢");
    expect(mediaReady(harness.sent)).toHaveLength(0);

    // 在 media_ready 之前打断（发起新一轮）。
    await harness.input(3, "等一下");
    await new Promise((resolve) => setTimeout(resolve, 400));

    const ready = mediaReady(harness.sent);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.payload.storyEventId).toBe(`${harness.sessionId}:2:0`);
  }, 10_000);

  it("每个 storyEventId 只投递一次（去重）", async () => {
    const harness = setup([[beat("我在等人。", { advance: "probe" })], ENTER_REVEAL], 100);
    await harness.hello();
    await harness.input(1, "你在等谁？");
    await harness.input(2, "然后呢");
    await new Promise((resolve) => setTimeout(resolve, 250));

    const ready = mediaReady(harness.sent);
    const ids = ready.map((message) => (message.type === "media_ready" ? message.payload.storyEventId : ""));
    expect(ids).toEqual([`${harness.sessionId}:2:0`]);
    expect(new Set(ids).size).toBe(ids.length);
  }, 10_000);

  it("S6b-fix1 §3：rin 会话发起后台媒体 → 同连接切到 yuna → 媒体完成后 yuna 连接上收不到 rin 的 media_ready", async () => {
    // 同一条连接（同一个 send）：rin hello → 进 reveal 发起媒体 → 同连接 hello yuna → 等待媒体完成。
    const sent: ServerMessage[] = [];
    const send: SendFn = (message) => void sent.push(message);
    const manager = createSessionManager({
      stt: immediateStt,
      llm: scriptedLlm([[beat("我在等人。", { advance: "probe" })], ENTER_REVEAL, [beat("嗯。")]]),
      tts: immediateTts,
      media: createPresetMedia({ delayMs: 300 }),
      packs: testPacksWithRinVisible(),
      log: silentLogger,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
    });
    active = manager;
    const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
      ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

    // S6f §1：缺省角色已是 yuna；本用例需要 rin 的媒体任务，显式加载隐藏包。
    await manager.handleMessage(send, envelope("hello", { characterId: "rin" }, "", 0));
    const rinSession = sent.findLast((m) => m.type === "session")?.sessionId ?? "";
    await manager.handleMessage(send, envelope("text_input", { text: "你在等谁？" }, rinSession, 1));
    await manager.handleMessage(send, envelope("text_input", { text: "然后呢" }, rinSession, 2));
    expect(mediaReady(sent)).toHaveLength(0); // 媒体还在后台生成。

    // 同一条连接切到 yuna。
    await manager.handleMessage(send, envelope("hello", { characterId: "yuna" }, "", 0));
    const yunaSession = sent.findLast((m) => m.type === "session")?.sessionId ?? "";
    expect(yunaSession).not.toBe(rinSession);

    // 等媒体任务（300ms）完成。
    await new Promise((resolve) => setTimeout(resolve, 450));

    // rin 的 media_ready 不应出现在这条连接上（rin 会话已解绑）。
    const leaked = mediaReady(sent).filter((m) => m.sessionId === rinSession);
    expect(leaked).toHaveLength(0);
    // yuna 会话本身没有发起媒体。
    expect(mediaReady(sent).filter((m) => m.sessionId === yunaSession)).toHaveLength(0);
  }, 10_000);

  it("S6b-fix1 §4：发起媒体任务时传入当前角色包与本轮之前的对话", async () => {
    const seen: Array<{ pack: string; history: readonly { role: string; text: string }[] }> = [];
    const capturingMedia = {
      preset: (_media: unknown, ctx: { pack: { id: string }; history: readonly { role: string; text: string }[] }) => {
        seen.push({ pack: ctx.pack.id, history: ctx.history });
        return Promise.resolve({ url: "/x.png", status: "ready" as const });
      },
    };
    const sent: ServerMessage[] = [];
    const send: SendFn = (message) => void sent.push(message);
    const manager = createSessionManager({
      stt: immediateStt,
      llm: scriptedLlm([[beat("我在等人。", { advance: "probe" })], ENTER_REVEAL]),
      tts: immediateTts,
      media: capturingMedia as never,
      packs: testPacksWithRinVisible(),
      log: silentLogger,
      idleTimeoutMs: 24 * 60 * 60 * 1000,
    });
    active = manager;
    const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
      ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

    await manager.handleMessage(send, envelope("hello", { characterId: "rin" }, "", 0));
    const sessionId = sent.findLast((m) => m.type === "session")?.sessionId ?? "";
    await manager.handleMessage(send, envelope("text_input", { text: "第一句话" }, sessionId, 1));
    // 第 2 轮进 reveal，发起媒体。此时 history 已含第 1 轮（用户+角色）。
    await manager.handleMessage(send, envelope("text_input", { text: "然后呢" }, sessionId, 2));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.pack).toBe("rin");
    // history 含第 1 轮的用户与角色台词，且不含本轮（第 2 轮）。
    const texts = seen[0]?.history.map((h) => h.text) ?? [];
    expect(texts).toContain("第一句话");
    expect(texts.some((t) => t.includes("我在等人"))).toBe(true);
    expect(texts).not.toContain("然后呢");
  });
});
