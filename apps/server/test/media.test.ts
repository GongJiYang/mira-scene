import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { createPresetMedia, DEFAULT_PRESET_DELAY_MS } from "../src/adapters/media/presetMedia";
import { silentLogger } from "../src/log";
import type { LLMPort, STTPort, TTSPort } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";

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
    const result = await port.preset({ type: "photo", id: "photo_letters" }, new AbortController().signal);
    expect(result).toEqual({ url: "/stage/photos/photo_letters.png", status: "ready" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(DEFAULT_PRESET_DELAY_MS - 50);
  });

  it("signal 中止时以 AbortError 结束，不产出结果", async () => {
    const port = createPresetMedia({ delayMs: 1_000 });
    const controller = new AbortController();
    const pending = port.preset({ type: "photo", id: "x" }, controller.signal);
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
});
