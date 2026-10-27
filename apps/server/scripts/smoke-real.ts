/**
 * 真实冒烟（§9）：real 模式跑 2 轮文字对话（不调用 STT），打印每轮 4 个阶段耗时并确认收到 tts_audio。
 * 只在 `.env` 里有 Key 时运行；缺 Key 时打印提示并以 0 退出（不算失败）。
 * Fish 返回 402 时打印清楚提示，并确认对话以无声 beat 正常结束。
 * Key 只从仓库根 `.env` 读取，绝不打印；调用次数上限：LLM ≤3、TTS ≤8。
 */
import WebSocket from "ws";
import { parseServerMessage, type ServerMessage } from "@mira/protocol";
import { readRepoEnvFile } from "../src/config";
import { startServer } from "../src/index";
import type { LogRecord } from "../src/log";

const TURN_TIMEOUT_MS = 20_000;
const MAX_LLM_CALLS = 3;
const MAX_TTS_CALLS = 8;

type Waiter = { predicate: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void };

function fail(reason: string): never {
  console.error(`SMOKE:REAL FAIL: ${reason}`);
  throw new Error(reason);
}

function pickEnv(): Record<string, string> {
  const file = readRepoEnvFile();
  const keys = [
    "LLM_PROVIDER",
    "COMMANDCODE_MODEL",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_MODEL",
    "FISH_API_KEY",
    "FISH_VOICE_ID",
    "FISH_TTS_MODEL",
  ];
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = (file[key] ?? "").trim();
    if (value !== "") out[key] = value;
  }
  return out;
}

function numberDetail(record: LogRecord, key: string): number | null {
  if (record.detail === null || typeof record.detail !== "object") return null;
  const value = (record.detail as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

async function main(): Promise<void> {
  const fileEnv = readRepoEnvFile();
  // S6a §2：按 provider 走。commandcode 用本地 `cmd` 的额度，不需要 DeepSeek Key。
  const llmProvider = (fileEnv.LLM_PROVIDER ?? "deepseek").trim() || "deepseek";
  const required = ["FISH_API_KEY"];
  if (llmProvider !== "commandcode") required.push("DEEPSEEK_API_KEY");
  const missing = required.filter((name) => (fileEnv[name] ?? "").trim() === "");
  if (missing.length > 0) {
    console.log(`[smoke:real] 跳过：.env 里缺少 ${missing.join(", ")}（需要真实 Key 才会运行）`);
    return;
  }

  const logs: LogRecord[] = [];
  const server = await startServer({
    port: 0,
    logger: (record) => logs.push(record),
    env: { ...process.env, PROVIDER_MODE: "real", ...pickEnv() },
  });

  const inbox: ServerMessage[] = [];
  const waiters: Waiter[] = [];
  const waitFor = (predicate: (message: ServerMessage) => boolean, label: string, timeoutMs = TURN_TIMEOUT_MS): Promise<ServerMessage> => {
    const existing = inbox.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === wrapped);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`等待超时：${label}`));
      }, timeoutMs);
      const wrapped = (message: ServerMessage) => {
        clearTimeout(timer);
        resolve(message);
      };
      waiters.push({ predicate, resolve: wrapped });
    });
  };

  let socket: WebSocket | null = null;
  try {
    const tokenBody = (await fetch(`http://127.0.0.1:${server.port}/session-token`).then((r) => r.json())) as { token?: string };
    if (typeof tokenBody.token !== "string") fail("拿不到握手令牌");
    const token = tokenBody.token;

    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token)}`);
    let seq = 0;
    let sessionId = "";

    socket.on("message", (raw) => {
      const parsed = parseServerMessage(JSON.parse(raw.toString()));
      if (!parsed.success) return;
      inbox.push(parsed.data);
      const pending = [...waiters];
      for (const waiter of pending) {
        if (waiter.predicate(parsed.data)) {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          waiter.resolve(parsed.data);
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      socket?.once("open", () => resolve());
      socket?.once("error", (error) => reject(error));
    });

    const send = (type: "hello" | "text_input" | "playback_started", payload: Record<string, unknown>, turnId: number): void => {
      socket?.send(JSON.stringify({ v: 1, sessionId, turnId, seq: seq++, ts: Date.now(), type, payload }));
    };

    send("hello", {}, 0);
    const session = await waitFor((message) => message.type === "session", "session");
    sessionId = session.sessionId;

    const rows: Array<{ turn: number; llmFirstBeat: number | null; ttsFirstAudio: number | null; firstAudioMs: number | null; degraded: boolean }> = [];

    for (const turnId of [1, 2]) {
      const text = turnId === 1 ? "你好，外面还在下雨吗？" : "你是在等人吗？";
      inbox.length = 0;
      const sentAt = Date.now();
      send("text_input", { text }, turnId);

      // 收到第一个 tts_audio 时模拟客户端上报 playback_started。
      const firstTts = await waitFor(
        (message) => (message.type === "tts_audio" && message.turnId === turnId) || (message.type === "turn_end" && message.turnId === turnId),
        `turn ${turnId} 首个音频或结束`,
      );
      let degraded = false;
      if (firstTts.type === "tts_audio") {
        send("playback_started", { turnId, seq: firstTts.payload.beatSeq, clientMs: Date.now() - sentAt }, turnId);
        const end = await waitFor((message) => message.type === "turn_end" && message.turnId === turnId, `turn ${turnId} turn_end`);
        degraded = false;
        if (end.type !== "turn_end") fail("turn_end 类型异常");
      } else {
        // 本轮没有 tts_audio（可能是 Fish 402 降级）：等 turn_end。
        degraded = inbox.some(
          (message) => message.type === "error" && message.turnId === turnId && message.payload.code === "tts_degraded",
        );
      }

      const turnLogs = logs.filter((record) => record.turnId === turnId);
      const llmFirstBeat = turnLogs.find((record) => record.event === "llm_first_beat")?.ms ?? null;
      const ttsFirstAudio = turnLogs.find((record) => record.event === "tts_first_audio")?.ms ?? null;
      const playback = turnLogs.find((record) => record.event === "playback_started");
      const firstAudioMs = playback === undefined ? null : numberDetail(playback, "first_audio_ms");

      rows.push({ turn: turnId, llmFirstBeat, ttsFirstAudio, firstAudioMs, degraded });

      const ttsCount = inbox.filter((message) => message.type === "tts_audio" && message.turnId === turnId).length;
      const beatCount = inbox.filter((message) => message.type === "beat" && message.turnId === turnId).length;
      if (degraded) {
        console.log(
          `[smoke:real] turn ${turnId}：Fish 返回 402（余额不足），本轮 ${beatCount} 个 beat 已降级为无声，正常结束`,
        );
      } else if (ttsCount === 0) {
        const errors = inbox.filter(
          (message): message is Extract<ServerMessage, { type: "error" }> => message.type === "error" && message.turnId === turnId,
        );
        const balance = errors.find((message) => /insufficient balance|not enough balance|402|余额/i.test(message.payload.message));
        if (balance) {
          console.log(
            `[smoke:real] 第三方余额不足：${balance.payload.code} — ${balance.payload.message}\n` +
              "[smoke:real] DeepSeek 账户余额为 0（402），无法完成真实对话。这是外部账户问题，不是链路问题；" +
              "充值后重跑即可。",
          );
          return;
        }
        const end = inbox.find((message) => message.type === "turn_end" && message.turnId === turnId);
        const turnEvents = logs.filter((record) => record.turnId === turnId).map((record) => record.event);
        fail(
          `turn ${turnId} 既没有 tts_audio 也没有降级提示；beats=${beatCount} ` +
            `errors=[${errors.map((message) => `${message.payload.code}:${message.payload.message}`).join(" | ")}] ` +
            `turn_end=${end?.type === "turn_end" ? end.payload.reason : "无"} events=[${turnEvents.join(",")}]`,
        );
      }
    }

    const llmCalls = logs.filter((record) => record.event === "prompt_version").length;
    const ttsCalls = logs.filter(
      (record) => record.event === "fish_call" && (record.detail as { port?: string } | undefined)?.port === "tts",
    ).length;

    console.log("[smoke:real] 每轮阶段耗时（服务端计时，ms）：");
    console.table(
      rows.map((row) => ({
        轮次: row.turn,
        "LLM 首句": row.llmFirstBeat,
        "TTS 首包": row.ttsFirstAudio,
        开始播放: row.firstAudioMs,
        无声降级: row.degraded,
      })),
    );
    console.log(`[smoke:real] 调用次数：LLM ${llmCalls}（≤${MAX_LLM_CALLS}）、TTS ${ttsCalls}（≤${MAX_TTS_CALLS}）`);

    if (llmCalls > MAX_LLM_CALLS) fail(`LLM 调用 ${llmCalls} 次，超过上限 ${MAX_LLM_CALLS}`);
    if (ttsCalls > MAX_TTS_CALLS) fail(`TTS 调用 ${ttsCalls} 次，超过上限 ${MAX_TTS_CALLS}`);
    console.log("SMOKE:REAL OK");
  } finally {
    socket?.close();
    await server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
