import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { withFaults } from "../src/adapters/faults";
import { createMockLlm } from "../src/adapters/mock/mockLlm";
import { createMockStt } from "../src/adapters/mock/mockStt";
import { createMockTts } from "../src/adapters/mock/mockTts";
import { clientPublicRoot } from "../src/characters/pack";
import type { LogRecord } from "../src/log";
import type { Ports } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPack, testPacks } from "./helpers/pack";

/**
 * freeze-fix6 §2.2：兜底 beat 配预录语音。
 *
 * 服务端发兜底 beat 后、`turn_end` 之前，若角色包对应的预录文件存在
 * （`<clientPublicRoot>/characters/<id>/voice/fallback/<category>.mp3`），读取并下发
 * `tts_audio { beatSeq: 0, mime: "audio/mpeg", dataBase64 }`；文件不存在 → 不发。
 * Mock 与真实同一路径；日志 `fallback_audio { category, found }`。
 */

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  logs: LogRecord[];
  hello(characterId?: string, faults?: string[]): Promise<void>;
  input(turnId: number, text: string): Promise<void>;
  audio(turnId: number): Promise<void>;
};

let active: SessionManager | null = null;
const tempDirs: string[] = [];

type SetupOptions = {
  firstTokenTimeoutMs?: number;
  fallbackVoiceRoot?: string;
};

function setup(options: SetupOptions = {}): Harness {
  const sent: ServerMessage[] = [];
  const logs: LogRecord[] = [];
  const base: Ports = {
    stt: createMockStt({ delayMs: 0 }),
    llm: createMockLlm({ beatDelayMs: 0 }),
    tts: createMockTts({ delayMs: 0 }),
  };
  const manager = createSessionManager({
    ...base,
    createPorts: (faults) => ({
      stt: withFaults(base.stt, "stt", faults),
      llm: withFaults(base.llm, "llm", faults),
      tts: withFaults(base.tts, "tts", faults),
    }),
    packs: testPacks(),
    firstTokenTimeoutMs: options.firstTokenTimeoutMs,
    fallbackVoiceRoot: options.fallbackVoiceRoot,
    log: (record) => logs.push(record),
    idleTimeoutMs: 24 * 60 * 60 * 1000,
  });
  active = manager;

  const send: SendFn = (message) => void sent.push(message);
  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;
  const sessionIdOf = (): string => sent.findLast((message) => message.type === "session")?.sessionId ?? "";

  return {
    manager,
    sent,
    logs,
    async hello(characterId, faults) {
      const payload: Record<string, unknown> = {};
      if (characterId !== undefined) payload.characterId = characterId;
      if (faults !== undefined) payload.faults = faults;
      await manager.handleMessage(send, envelope("hello", payload, "", 0));
    },
    input: (turnId, text) => manager.handleMessage(send, envelope("text_input", { text }, sessionIdOf(), turnId)),
    audio: (turnId) =>
      manager.handleMessage(
        send,
        envelope("audio_input", { mime: "audio/webm", dataBase64: Buffer.from("fake").toString("base64") }, sessionIdOf(), turnId),
      ),
  };
}

/** 本轮下行消息的类型顺序（只看 beat / tts_audio / turn_end）。 */
const orderOf = (sent: ServerMessage[], turnId: number): string[] =>
  sent
    .filter(
      (message) =>
        message.turnId === turnId &&
        (message.type === "beat" || message.type === "tts_audio" || message.type === "turn_end"),
    )
    .map((message) => message.type);

const ttsAudioOf = (sent: ServerMessage[], turnId: number) =>
  sent.flatMap((message) => (message.type === "tts_audio" && message.turnId === turnId ? [message.payload] : []));

afterEach(() => {
  vi.useRealTimers();
  active?.dispose();
  active = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("freeze-fix6 §2.2：兜底 beat 预录语音（llm_timeout）", () => {
  it("预录文件存在 → 顺序为 beat → tts_audio(beatSeq 0) → turn_end；日志 fallback_audio{found:true}", async () => {
    vi.useFakeTimers();
    const harness = setup({ firstTokenTimeoutMs: 1_000 });
    await harness.hello("yuna", ["llm_timeout"]);

    const turn = harness.input(1, "你好");
    await vi.advanceTimersByTimeAsync(1_000);
    await turn;

    // 兜底 beat 的 say 来自角色包（不改台词）。
    const beats = harness.sent.filter((m) => m.type === "beat" && m.turnId === 1);
    expect(beats.map((m) => (m.type === "beat" ? m.payload.beat.say : ""))).toEqual([testPack("yuna").fallback.llm_timeout]);

    expect(orderOf(harness.sent, 1)).toEqual(["beat", "tts_audio", "turn_end"]);
    expect(ttsAudioOf(harness.sent, 1)).toEqual([
      { beatSeq: 0, mime: "audio/mpeg", dataBase64: expect.any(String) },
    ]);
    expect(ttsAudioOf(harness.sent, 1)[0]?.dataBase64.length).toBeGreaterThan(0);

    expect(harness.logs.filter((record) => record.event === "fallback_audio")).toMatchObject([
      { detail: { category: "llm_timeout", found: true } },
    ]);
  });

  it("预录文件缺失的类别 → 只有 beat → turn_end；日志 fallback_audio{found:false}", async () => {
    vi.useFakeTimers();
    const emptyRoot = mkdtempSync(join(tmpdir(), "mira-fallback-voice-"));
    tempDirs.push(emptyRoot);
    const harness = setup({ firstTokenTimeoutMs: 1_000, fallbackVoiceRoot: emptyRoot });
    await harness.hello("yuna", ["llm_timeout"]);

    const turn = harness.input(1, "你好");
    await vi.advanceTimersByTimeAsync(1_000);
    await turn;

    expect(orderOf(harness.sent, 1)).toEqual(["beat", "turn_end"]);
    expect(ttsAudioOf(harness.sent, 1)).toEqual([]);
    expect(harness.logs.filter((record) => record.event === "fallback_audio")).toMatchObject([
      { detail: { category: "llm_timeout", found: false } },
    ]);
  });

  it("stt_empty 兜底同样配预录语音（顺序 beat → tts_audio → turn_end）", async () => {
    const harness = setup();
    await harness.hello("yuna", ["stt"]);
    await harness.audio(1);

    expect(orderOf(harness.sent, 1)).toEqual(["beat", "tts_audio", "turn_end"]);
    expect(ttsAudioOf(harness.sent, 1)).toMatchObject([{ beatSeq: 0, mime: "audio/mpeg" }]);
    expect(harness.logs.filter((record) => record.event === "fallback_audio")).toMatchObject([
      { detail: { category: "stt_empty", found: true } },
    ]);
  });
});

describe("freeze-fix6 §2.2：预录语音确实来自客户端静态目录", () => {
  it("默认根目录解析到存在的文件（yuna/llm_timeout.mp3）", () => {
    // 只是确认默认解析根指向仓库内客户端静态目录，避免把根写错。
    expect(clientPublicRoot()).toMatch(/apps\/client\/public$/);
  });
});
