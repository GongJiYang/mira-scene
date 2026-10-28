import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { silentLogger } from "../src/log";
import type { LLMContext, LLMPort, MediaContext, STTPort, TTSPort } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPack, testPacks } from "./helpers/pack";
import type { PresetMediaResult } from "../src/ports";

/**
 * freeze-fix3 §2/§4：截图生成期间 nudge 轮的 `photoWaitingNote`。
 * 假媒体端口延迟就绪：reveal 后发 nudge → 提示词含 photoWaitingNote；就绪后再发 nudge → 不含。
 */

type LlmBeatFixture = { say: string; emotion?: string; suggest?: string | null; advance?: string | null };

function beat(say: string, extra: Partial<LlmBeatFixture> = {}): LlmBeatFixture {
  return { say, emotion: "neutral", suggest: null, advance: null, ...extra };
}

const ENTER_REVEAL: LlmBeatFixture[] = [
  beat("我翻翻……", { emotion: "sad", suggest: "show_item", advance: "reveal" }),
];

const immediateStt: STTPort = { transcribe: () => Promise.resolve("你好") };
const immediateTts: TTSPort = {
  synthesize: () => Promise.resolve({ mime: "audio/wav", data: Buffer.from([1]) }),
};

/** 假媒体端口：延迟就绪，可控。 */
function controllableMedia() {
  let resolveReady: ((result: PresetMediaResult) => void) | null = null;
  const pending: Array<{ media: unknown; ctx: MediaContext }> = [];
  return {
    pending,
    port: {
      preset(media: unknown, ctx: MediaContext): Promise<PresetMediaResult> {
        pending.push({ media, ctx });
        return new Promise<PresetMediaResult>((resolve) => {
          resolveReady = resolve;
        });
      },
    },
    ready(result: PresetMediaResult = { url: "/stage/photos/photo_first_stream.png", status: "ready" }) {
      resolveReady?.(result);
      resolveReady = null;
    },
  };
}

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  contexts: LLMContext[];
  media: ReturnType<typeof controllableMedia>;
  hello(): Promise<void>;
  input(turnId: number, text: string): Promise<void>;
  nudge(turnId: number): Promise<void>;
};

let active: SessionManager | null = null;

function setup(scripts: LlmBeatFixture[][]): Harness {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const contexts: LLMContext[] = [];
  const pending = [...scripts];
  const llm: LLMPort = {
    async *streamBeats(ctx) {
      contexts.push(ctx);
      yield* (pending.shift() ?? []);
    },
  };
  const media = controllableMedia();
  const manager = createSessionManager({
    stt: immediateStt,
    llm,
    tts: immediateTts,
    media: media.port as never,
    packs: testPacks(),
    log: silentLogger,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
  });
  active = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;
  const sessionIdOf = (): string => sent.findLast((message) => message.type === "session")?.sessionId ?? "";

  return {
    manager,
    sent,
    contexts,
    media,
    async hello() {
      await manager.handleMessage(send, envelope("hello", {}, "", 0));
    },
    input: (turnId, text) => manager.handleMessage(send, envelope("text_input", { text }, sessionIdOf(), turnId)),
    nudge: (turnId) => manager.handleMessage(send, envelope("nudge", {}, sessionIdOf(), turnId)),
  };
}

afterEach(() => {
  active?.dispose();
  active = null;
});

describe("服务端：截图未就绪时 nudge 轮追加 photoWaitingNote（§2）", () => {
  it("reveal 尚未就绪 → nudge 提示词含 photoWaitingNote；就绪后再 nudge → 不含", async () => {
    const harness = setup([[beat("我在等人。", { advance: "probe" })], ENTER_REVEAL, [beat("嗯。")], [beat("嗯嗯。")]]);
    await harness.hello();
    await harness.input(1, "你在等谁？");
    await harness.input(2, "然后呢");
    // 第 2 轮进入 reveal 并发起媒体（假端口尚未就绪）。

    const note = testPack("yuna").photoWaitingNote;

    await harness.nudge(3);
    const nudge1 = harness.contexts.at(-1);
    expect(nudge1?.nudge).toBe(true);
    expect(nudge1?.sceneNotes ?? "").toContain(note);

    // 让媒体就绪，等 media_ready 送达。
    harness.media.ready();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await harness.nudge(4);
    const nudge2 = harness.contexts.at(-1);
    expect(nudge2?.sceneNotes ?? "").not.toContain(note);
  }, 10_000);

  it("普通轮（非 nudge）不追加 photoWaitingNote", async () => {
    const harness = setup([[beat("我在等人。", { advance: "probe" })], ENTER_REVEAL, [beat("嗯。")], [beat("嗯嗯。")]]);
    await harness.hello();
    await harness.input(1, "你在等谁？");
    await harness.input(2, "然后呢");

    const note = testPack("yuna").photoWaitingNote;
    await harness.input(3, "接着说");
    const normal = harness.contexts.at(-1);
    expect(normal?.nudge).toBeFalsy();
    expect(normal?.sceneNotes ?? "").not.toContain(note);
  }, 10_000);
});
