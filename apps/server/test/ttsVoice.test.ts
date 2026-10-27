import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { createMockLlm } from "../src/adapters/mock/mockLlm";
import { createMockStt } from "../src/adapters/mock/mockStt";
import { silentLogger } from "../src/log";
import type { TTSAudio, TTSPort, TtsOptions } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPacks } from "./helpers/pack";

/**
 * S6b-fix1 §1/§2：TTS 音色按会话角色包决定；Mock 按角色分目录。
 * 断言 rin 会话和 yuna 会话的 TTS 各自收到对应的 voiceId / characterId。
 */

type Captured = { text: string; opts: TtsOptions };

function recordingTts(captured: Captured[]): TTSPort {
  return {
    synthesize(text, opts): Promise<TTSAudio> {
      captured.push({ text, opts });
      return Promise.resolve({ mime: "audio/wav", data: Buffer.from([1]) });
    },
  };
}

let active: SessionManager | null = null;

function setup(captured: Captured[], resolveVoiceId: (packId: string) => string | undefined) {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const manager = createSessionManager({
    stt: createMockStt({ delayMs: 0 }),
    llm: createMockLlm({ beatDelayMs: 0 }),
    tts: recordingTts(captured),
    packs: testPacks(),
    resolveVoiceId: (pack) => resolveVoiceId(pack.id),
    log: silentLogger,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
  });
  active = manager;
  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;
  return {
    sent,
    async hello(characterId: string) {
      await manager.handleMessage(send, envelope("hello", { characterId }, "", 0));
      return sent.findLast((m) => m.type === "session")?.sessionId ?? "";
    },
    input(sessionId: string, turnId: number, text: string) {
      return manager.handleMessage(send, envelope("text_input", { text }, sessionId, turnId));
    },
  };
}

afterEach(() => {
  active?.dispose();
  active = null;
});

describe("TTS 音色按角色包决定（S6b-fix1 §1）", () => {
  it("rin 会话收到 rin 的 voiceId，yuna 会话收到 yuna 的 voiceId", async () => {
    const captured: Captured[] = [];
    const voices: Record<string, string> = { rin: "voice-rin-xxx", yuna: "voice-yuna-yyy" };
    const h = setup(captured, (id) => voices[id]);

    const rinSession = await h.hello("rin");
    await h.input(rinSession, 1, "你好");

    const yunaSession = await h.hello("yuna");
    await h.input(yunaSession, 1, "你好");

    const rinOpts = captured.filter((_, i) => i < captured.length).map((c) => c.opts);
    // 前若干条是 rin 这一轮（arrive/greeting 两句），后面是 yuna。
    const rinVoiceIds = new Set(captured.slice(0, 2).map((c) => c.opts.voiceId));
    const yunaVoiceIds = new Set(captured.slice(2).map((c) => c.opts.voiceId));
    expect(rinVoiceIds).toEqual(new Set(["voice-rin-xxx"]));
    expect(yunaVoiceIds).toEqual(new Set(["voice-yuna-yyy"]));
    expect(rinOpts.length).toBeGreaterThan(0);
  });

  it("Mock 模式下 characterId 按角色包传给 TTS（S6b-fix1 §2 分目录）", async () => {
    const captured: Captured[] = [];
    const h = setup(captured, () => undefined);

    const rinSession = await h.hello("rin");
    await h.input(rinSession, 1, "你好");
    const yunaSession = await h.hello("yuna");
    await h.input(yunaSession, 1, "你好");

    const rinCharIds = new Set(captured.slice(0, 2).map((c) => c.opts.characterId));
    const yunaCharIds = new Set(captured.slice(2).map((c) => c.opts.characterId));
    expect(rinCharIds).toEqual(new Set(["rin"]));
    expect(yunaCharIds).toEqual(new Set(["yuna"]));
  });
});
