/**
 * S6n §3/§4/§6 集成测试（假适配器，零真实网络）：
 * - BYOK 会话用访问者的 Key 构建适配器（假工厂断言收到的 Key）；
 * - 两个会话一个 mock 一个 real 互不影响；
 * - 恢复会话（resumeSessionId）沿用原模式与 Key，不重读 hello；
 * - §4 脱敏：特征串假 Key 走完一轮 BYOK 会话，日志 / 观测缓冲 / 下行消息里都不含它；
 * - §3 voice_unavailable：Fish 4xx 音色错误 → 会话级 error，不重试、不省略 reference_id。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, HelloKeys, ServerMessage } from "@mira/protocol";
import { FishApiError } from "../src/adapters/fish/errors";
import type { Logger, LogRecord } from "../src/log";
import type { LLMPort, Ports, TTSPort } from "../src/ports";
import type { ProviderCredentials } from "../src/config";
import { planSession, resolveKeys, type BuiltProviders, type RequestedMode } from "../src/providers";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { createObsBuffer } from "../src/obs/buffer";
import { sanitize } from "../src/obs/sanitize";
import { testPacks } from "./helpers/pack";
import { createMockLlm } from "../src/adapters/mock/mockLlm";
import { createMockStt } from "../src/adapters/mock/mockStt";
import { createMockTts } from "../src/adapters/mock/mockTts";
import { createMockSceneWriter } from "../src/adapters/mock/mockSceneWriter";

const EMPTY_SERVER: ProviderCredentials = {
  deepseek: { apiKey: "", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  fish: { apiKey: "", baseUrl: "https://api.fish.audio/v1", voiceId: "", ttsModel: "s2.1-pro-free" },
  image: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "img" },
};

/** 记录工厂收到的 Key（用于断言「用访问者的 Key 构建」）。 */
type BuildCall = { mode: "mock" | "real"; keys: ReturnType<typeof resolveKeys> };

function recordingBuild(calls: BuildCall[], ttsOverride?: TTSPort, llmOverride?: LLMPort) {
  return (mode: "mock" | "real", keys: ReturnType<typeof resolveKeys>): BuiltProviders => {
    calls.push({ mode, keys });
    const tts = ttsOverride ?? createMockTts({ manifestPath: undefined });
    const ports: Ports = { stt: createMockStt({ delayMs: 0, texts: ["你好"] }), llm: llmOverride ?? createMockLlm({ beatDelayMs: 0 }), tts };
    return { ports, sceneWriter: createMockSceneWriter(), sceneImageGen: undefined, media: { preset: async (m) => ({ url: `/x/${m.id}.png`, status: "ready" }) } };
  };
}

let active: SessionManager | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
});

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  logs: LogRecord[];
  hello(payload: { mode?: RequestedMode; keys?: HelloKeys; resumeSessionId?: string }): Promise<string>;
  input(sessionId: string, turnId: number, text: string): Promise<void>;
};

function setup(deps: { calls: BuildCall[]; ttsOverride?: TTSPort; llmOverride?: LLMPort; logger?: Logger }): Harness {
  const sent: ServerMessage[] = [];
  const logs: LogRecord[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const logger = deps.logger ?? ((record) => logs.push(record));
  const manager = createSessionManager({
    // 顶层 ports 仅作为 mock 兜底；本测试的会话都经 buildProviders 组装。
    stt: createMockStt({ delayMs: 0, texts: ["你好"] }),
    llm: createMockLlm({ beatDelayMs: 0 }),
    tts: createMockTts(),
    packs: testPacks(),
    log: logger,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    planSession: (mode, keys) => planSession(mode, keys, EMPTY_SERVER),
    buildProviders: recordingBuild(deps.calls, deps.ttsOverride, deps.llmOverride),
    mockProviders: recordingBuild(deps.calls, deps.ttsOverride, deps.llmOverride)("mock", resolveKeys(undefined, EMPTY_SERVER)),
  });
  active = manager;

  const envelope = (payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type: "hello", payload }) as ClientMessage;

  return {
    manager,
    sent,
    logs,
    async hello(payload) {
      await manager.handleMessage(send, envelope(payload, "", 0));
      return sent.findLast((m) => m.type === "session")?.sessionId ?? "";
    },
    input(sessionId, turnId, text) {
      return manager.handleMessage(
        send,
        ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type: "text_input", payload: { text } } as ClientMessage),
      );
    },
  };
}

describe("S6n §3：BYOK 会话用访问者的 Key 构建适配器", () => {
  it("auto + 访问者两类 Key → real，工厂收到访问者的 Key", async () => {
    const calls: BuildCall[] = [];
    const h = setup({ calls });
    const plan = await h.hello({ mode: "auto", keys: { deepseek: { apiKey: "sk-USER-LLM" }, fish: { apiKey: "sk-USER-VOICE" } } });
    expect(plan).not.toBe("");

    const realCall = calls.find((call) => call.mode === "real");
    expect(realCall).toBeDefined();
    expect(realCall?.keys.deepseek.value).toBe("sk-USER-LLM");
    expect(realCall?.keys.deepseek.source).toBe("user");
    expect(realCall?.keys.fish.value).toBe("sk-USER-VOICE");
  });

  it("auto 且访问者无 Key（服务端也没有）→ mock，工厂只被 mock 调用", async () => {
    const calls: BuildCall[] = [];
    const h = setup({ calls });
    await h.hello({ mode: "auto" });
    expect(calls.some((call) => call.mode === "real")).toBe(false);
  });

  it("显式 real 但缺 Key → error{real_unavailable}，不建会话", async () => {
    const calls: BuildCall[] = [];
    const h = setup({ calls });
    await h.hello({ mode: "real" });
    const error = h.sent.find((m) => m.type === "error");
    expect(error).toMatchObject({ payload: { code: "real_unavailable", scope: "session", retryable: false } });
    expect(h.sent.some((m) => m.type === "session")).toBe(false);
  });
});

describe("S6n §3：两个会话互不影响", () => {
  it("一个 mock 一个 real，各自绑定自己的模式与 capabilities", async () => {
    const calls: BuildCall[] = [];
    const h = setup({ calls });
    const mockId = await h.hello({ mode: "mock" });
    const realId = await h.hello({ mode: "real", keys: { deepseek: { apiKey: "k1" }, fish: { apiKey: "k2" } } });
    expect(mockId).not.toBe(realId);

    const sessions = h.sent.filter((m) => m.type === "session");
    const mockSession = sessions.find((m) => m.sessionId === mockId);
    const realSession = sessions.find((m) => m.sessionId === realId);
    expect(mockSession).toMatchObject({ payload: { mode: "mock" } });
    expect(realSession).toMatchObject({ payload: { mode: "real" } });
    // 两会话各自独立发消息，互不干扰。
    await h.input(realId, 1, "你好");
    const realBeats = h.sent.filter((m) => m.type === "beat" && m.sessionId === realId);
    const mockBeats = h.sent.filter((m) => m.type === "beat" && m.sessionId === mockId);
    expect(realBeats.length).toBeGreaterThan(0);
    expect(mockBeats.length).toBe(0);
  });
});

describe("S6n §2：恢复会话沿用原模式与 Key", () => {
  it("resumeSessionId 恢复用原模式，不重读 hello 里的 mode / keys", async () => {
    const calls: BuildCall[] = [];
    const h = setup({ calls });
    const id = await h.hello({ mode: "real", keys: { deepseek: { apiKey: "k1" }, fish: { apiKey: "k2" } } });
    const before = calls.length;
    // 恢复时传 mock 与不同 Key，应被忽略。
    await h.hello({ mode: "mock", keys: { deepseek: { apiKey: "other" } }, resumeSessionId: id } as never);
    const sessions = h.sent.filter((m) => m.type === "session");
    const resumed = sessions.at(-1);
    expect(resumed).toMatchObject({ sessionId: id, payload: { mode: "real" } });
    // 恢复不重新构建适配器。
    expect(calls.length).toBe(before);
  });
});

describe("S6n §4：脱敏（特征串假 Key 不走漏）", () => {
  const FEATURE = "sk-TESTKEY-xxxxxxxx";

  it("BYOK 会话一轮后，日志 / 观测缓冲 / 下行消息都不含特征串", async () => {
    const logs: LogRecord[] = [];
    const obs = createObsBuffer();
    // 测试注入的 logger 同时旁路写入观测缓冲（模拟 index.ts 的双写）。
    const logger: Logger = (record) => {
      obs.push(record);
      logs.push(record);
    };
    const calls: BuildCall[] = [];
    // 假 LLM 抛出的错误信息里带上 Key（模拟请求头 / URL 参数被回显）→ 走 turn_failed 脱敏路径。
    const leakyLlm: LLMPort = {
      // eslint-disable-next-line require-yield
      async *streamBeats() {
        throw new Error(`request failed: authorization: Bearer ${FEATURE} (api_key=${FEATURE})`);
      },
    };
    const h = setup({ calls, logger, llmOverride: leakyLlm });
    const id = await h.hello({
      mode: "real",
      keys: { deepseek: { apiKey: FEATURE }, fish: { apiKey: FEATURE }, image: { apiKey: FEATURE, baseUrl: "https://img/v1" } },
    });
    await h.input(id, 1, "你好");

    // 确实走了 turn_failed（LLM 意外错误），且错误信息里的 Key 已被替换为 [redacted]。
    const failed = logs.find((record) => record.event === "turn_failed");
    expect(failed).toBeDefined();
    expect((failed?.detail as { message?: string } | undefined)?.message).toContain("[redacted]");
    expect((failed?.detail as { message?: string } | undefined)?.message).not.toContain(FEATURE);

    // 日志（原始 Logger 记录）里不含特征串。
    expect(JSON.stringify(logs)).not.toContain(FEATURE);
    // 观测缓冲（经 sanitize 后的记录）里不含特征串。
    expect(JSON.stringify(obs.snapshot())).not.toContain(FEATURE);
    // 下行消息里不含特征串。
    expect(JSON.stringify(h.sent)).not.toContain(FEATURE);
  });

  it("hello 的日志只记 mode 与 byok 布尔，不含任何 Key", async () => {
    const calls: BuildCall[] = [];
    const h = setup({ calls });
    await h.hello({ mode: "real", keys: { deepseek: { apiKey: FEATURE }, fish: { apiKey: FEATURE } } });
    const provision = h.logs.find((record) => record.event === "hello_provision");
    expect(provision?.detail).toEqual({ mode: "real", byok: { llm: true, voice: true, image: false } });
  });

  it("sanitize：Key 字段名的值替换为 [redacted]（含 authorization）", () => {
    const out = sanitize({ ts: 1, event: "x", detail: { apiKey: FEATURE, authorization: `Bearer ${FEATURE}`, key: FEATURE } });
    expect(JSON.stringify(out)).not.toContain(FEATURE);
    expect(out.detail?.apiKey).toBe("[redacted]");
    expect(out.detail?.authorization).toBe("[redacted]");
  });
});

describe("S6n §3：voice_unavailable（不重试、不省略 reference_id）", () => {
  it("Fish 4xx 音色错误 → 会话级 error{voice_unavailable}，且 TTS 只被调用一次", async () => {
    let calls = 0;
    const tts: TTSPort = {
      async synthesize(_text, _opts, _signal) {
        calls += 1;
        throw new FishApiError("fish_voice", "Fish TTS 返回 400");
      },
    };
    const buildCalls: BuildCall[] = [];
    const h = setup({ calls: buildCalls, ttsOverride: tts });
    const id = await h.hello({ mode: "real", keys: { deepseek: { apiKey: "k1" }, fish: { apiKey: "k2" } } });
    await h.input(id, 1, "你好");

    const error = h.sent.find((m) => m.type === "error" && m.payload.code === "voice_unavailable");
    expect(error).toMatchObject({ payload: { scope: "session", retryable: false } });
    // 不重试（第一句就停）——voiced 错误不在 synthesizeWithRetry 里重试。
    expect(calls).toBe(1);
    // 不降级成 tts_degraded。
    expect(h.sent.some((m) => m.type === "error" && m.payload.code === "tts_degraded")).toBe(false);
  });
});

describe("S6n §3：音色覆盖透传", () => {
  it("访问者填 voiceId → 会话的 TTS 收到该音色", async () => {
    const voiceIds: Array<string | undefined> = [];
    const tts: TTSPort = {
      async synthesize(_text, opts) {
        voiceIds.push(opts.voiceId);
        return { mime: "audio/wav", data: Buffer.from([1]) };
      },
    };
    const calls: BuildCall[] = [];
    const h = setup({ calls, ttsOverride: tts });
    const id = await h.hello({
      mode: "real",
      keys: { deepseek: { apiKey: "k1" }, fish: { apiKey: "k2", voiceId: "my-voice" } },
    });
    await h.input(id, 1, "你好");
    expect(voiceIds.length).toBeGreaterThan(0);
    expect(new Set(voiceIds)).toEqual(new Set(["my-voice"]));
  });
});
