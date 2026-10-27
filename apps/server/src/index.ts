import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { parseClientMessage, type ServerMessage } from "@mira/protocol";
import { createCommandCodeLlm } from "./adapters/commandcode/commandCodeLlm";
import { assertCommandCodeReady } from "./adapters/commandcode/preflight";
import { createDeepSeekLlm } from "./adapters/deepseek/deepseekLlm";
import { withSttErrorDegrade } from "./adapters/fish/degrade";
import { createFishStt } from "./adapters/fish/fishStt";
import { createFishTts } from "./adapters/fish/fishTts";
import { parseFaults, readFirstTokenTimeoutMs, withFaults } from "./adapters/faults";
import { createMockLlm } from "./adapters/mock/mockLlm";
import { createMockStt } from "./adapters/mock/mockStt";
import { createMockTts } from "./adapters/mock/mockTts";
import { createMockSceneWriter } from "./adapters/mock/mockSceneWriter";
import { createImageGenMedia, defaultOutDir } from "./adapters/media/imageGen";
import { generatedFileFor } from "./adapters/media/generatedRoute";
import { createPresetMedia } from "./adapters/media/presetMedia";
import { loadPacks } from "./characters/pack";
import { applyRepoEnv, loadConfig } from "./config";
import { consoleLogger, type Logger } from "./log";
import type { LLMPort, Ports, STTPort, TTSPort } from "./ports";
import { withPaceCheck } from "./quality/paceGuard";
import { createSceneWriter } from "./scene/writer";
import { createSessionManager, type SendFn } from "./session";
import { createTokenStore } from "./tokens";

/** 单条消息上限（D8 复核）：2MB，超限以 1009 关闭连接。 */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export type ServerHandle = {
  port: number;
  close(): Promise<void>;
};

export type StartServerOptions = {
  /** 默认取 config.port（8787）；冒烟脚本传 0 使用随机端口。 */
  port?: number;
  /** 默认 consoleLogger；测试注入以断言日志事件。 */
  logger?: Logger;
  /** 默认 process.env；smoke:real 注入从 `.env` 读到的环境。 */
  env?: NodeJS.ProcessEnv;
};

function messageBytes(raw: RawData): number {
  if (Array.isArray(raw)) return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  return raw.byteLength;
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * 进程内启动：GET /health、GET /session-token；WebSocket 只升级带有效令牌的 /ws。
 */
export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const config = loadConfig(options.env ?? process.env);
  const logger = options.logger ?? consoleLogger;
  const tokens = createTokenStore();
  const { providers } = config;

  // S6b §1：启动时加载所有角色包；任何一个不合法 → 抛错，服务端启动失败（不静默降级）。
  const packs = loadPacks();
  logger({ ts: Date.now(), event: "packs_loaded", detail: { ids: [...packs.keys()] } });

  // S6b-fix1 §1：启动时按每个角色包的 `fishVoiceIdEnv` 读环境变量。
  // 真实模式下任一角色缺失对应环境变量 → 启动报错（s6b §1 原要求）；Mock 模式全部为空（不读 Key）。
  const voiceIds = new Map<string, string>();
  if (config.providerMode === "real") {
    for (const pack of packs.values()) {
      const envName = pack.voice.fishVoiceIdEnv;
      const value = (options.env?.[envName] ?? process.env[envName] ?? "").trim();
      if (value === "") {
        throw new Error(`真实模式缺少 TTS 音色环境变量 ${envName}（角色 ${pack.id} 需要，请在 .env 配置）`);
      }
      voiceIds.set(pack.id, value);
    }
  }

  // S6a §2 契约：real + commandcode 时，启动检查 cmd 可执行且已登录；不满足直接报错退出，不降级。
  if (config.providerMode === "real" && config.llmProvider === "commandcode") {
    await assertCommandCodeReady();
    logger({ ts: Date.now(), event: "commandcode_ready" });
  }

  // 按模式选择适配器：real 模式下缺 Key 的端口单独回退到 Mock，并记 provider_fallback（§4）。
  function buildPorts(): Ports {
    const wantReal = config.providerMode === "real";
    const fallback = (port: string, reason: string): void => {
      logger({ ts: Date.now(), event: "provider_fallback", detail: { port, reason } });
    };

    let stt: STTPort;
    if (wantReal && providers.fish.apiKey !== "") {
      stt = withSttErrorDegrade(
        createFishStt({ baseUrl: providers.fish.baseUrl, apiKey: providers.fish.apiKey, log: logger }),
        { log: logger },
      );
    } else {
      if (wantReal) fallback("stt", "missing_key");
      stt = createMockStt();
    }

    let llm: LLMPort;
    // S6b §1：提示词改由角色包提供，LLM 适配器不再持有单一提示词（每轮从 ctx.pack 渲染）。
    if (wantReal && config.llmProvider === "commandcode") {
      // D39 / S6a §2：走 Command Code 的额度。启动契约已在 startServer 里检查过。
      llm = createCommandCodeLlm({
        model: config.commandCodeModel,
        log: logger,
      });
    } else if (wantReal && providers.deepseek.apiKey !== "") {
      llm = createDeepSeekLlm({
        baseUrl: providers.deepseek.baseUrl,
        apiKey: providers.deepseek.apiKey,
        model: providers.deepseek.model,
        log: logger,
      });
    } else {
      if (wantReal) fallback("llm", "missing_key");
      llm = createMockLlm();
    }

    let tts: TTSPort;
    if (wantReal && providers.fish.apiKey !== "") {
      tts = withPaceCheck(
        createFishTts({
          baseUrl: providers.fish.baseUrl,
          apiKey: providers.fish.apiKey,
          // S6b-fix1 §1：默认音色置空 —— 真实音色由会话层按角色包经 TtsOptions.voiceId 注入。
          voiceId: "",
          model: providers.fish.ttsModel,
          log: logger,
        }),
        { log: logger },
      );
    } else {
      if (wantReal) fallback("tts", "missing_key");
      // S5 §1：Mock 语音方案 B。manifest 存在但非法会在启动时（此处）直接抛错。
      tts = createMockTts({ manifestPath: config.voiceManifestPath, log: logger });
    }

    return { stt, llm, tts };
  }

  // 每个会话一份端口，故障（hello.faults / FAULTS）在创建端口实例时套上装饰器。
  const basePorts = buildPorts();
  // sessionId → 连接：`ws_drop` 需要服务端主动关闭会话所在的连接。
  const sessionSockets = new Map<string, WebSocket>();
  // send 回调 → 连接：S6b §1 未知 characterId 时关闭对应连接。
  const socketSendMap = new Map<SendFn, WebSocket>();
  const sessions = createSessionManager({
    ...basePorts,
    createPorts: (faults) =>
      faults.length === 0
        ? basePorts
        : {
            stt: withFaults(basePorts.stt, "stt", faults),
            llm: withFaults(basePorts.llm, "llm", faults),
            tts: withFaults(basePorts.tts, "tts", faults),
          },
    defaultFaults: parseFaults(process.env.FAULTS),
    firstTokenTimeoutMs: readFirstTokenTimeoutMs(),
    // D27 / S6b §5.5：媒体端口。`IMAGE_API_KEY` 配置时用真实生图（配置选择，非余额降级）；
    // 未配置时沿用预置照片适配器（等待 config.mediaPresetDelayMs 后发送 media_ready）。
    // 提示词按 media.id 反查所属角色包的 imagePrompt 模板（{{conversation}} 由 buildImagePrompt 填）。
    media:
      config.providerMode === "real" && providers.image.apiKey !== ""
        ? createImageGenMedia({
            baseUrl: providers.image.baseUrl,
            apiKey: providers.image.apiKey,
            model: providers.image.model,
            // S6b-fix1 §5：写到服务端数据目录 var/generated/（GENERATED_DIR 可覆盖）。
            outDir: defaultOutDir(options.env ?? process.env),
            log: (event, detail) => logger({ ts: Date.now(), event, detail }),
          })
        : createPresetMedia({ delayMs: config.mediaPresetDelayMs }),
    dropConnection: (sessionId) => {
      const socket = sessionSockets.get(sessionId);
      if (!socket) return;
      sessionSockets.delete(sessionId);
      socket.close(1011, "fault:ws_drop");
    },
    // S6b §1：未知 characterId → 发完 error 后关闭连接。
    closeConnection: (send) => {
      const socket = socketSendMap.get(send);
      if (socket) socket.close(1008, "unknown_character");
    },
    packs,
    // S6b-fix1 §1：按角色包解析启动时读到的音色。
    resolveVoiceId: (pack) => voiceIds.get(pack.id),
    log: logger,
    sessionTurnLimit: config.sessionTurnLimit,
    dailyTurnLimit: config.dailyTurnLimit,
    // S6c §4：换背景端口（Mock 用查表；真实按 LLM_PROVIDER 复用适配器）。
    sceneWriter:
      config.providerMode === "real"
        ? createSceneWriter({
            provider: config.llmProvider,
            deepseek: providers.deepseek.apiKey !== "" ? providers.deepseek : undefined,
            commandcode: { model: config.commandCodeModel },
            log: logger,
          })
        : createMockSceneWriter(),
    // S6c §4：生图参数（真实模式用 image credentials；Mock 模式也要能跑，用假 fetch 或预置图由 e2e 处理）。
    sceneImageGen:
      config.providerMode === "real" && providers.image.apiKey !== ""
        ? {
            baseUrl: providers.image.baseUrl,
            apiKey: providers.image.apiKey,
            model: providers.image.model,
            outDir: defaultOutDir(options.env ?? process.env),
            log: (event, detail) => logger({ ts: Date.now(), event, detail }),
          }
        : undefined,
    // S6c §4：参考图 = 当前背景（桌面 / 手机）。由会话层按 pack.stage.background 动态解析本地文件路径。
    sceneReferencePaths: undefined,
  });

  // S6b-fix1 §5：真实生图输出目录（服务端数据目录），HTTP 路由 GET /generated/<file> 从这里读。
  const generatedDir = defaultOutDir(options.env ?? process.env);

  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "GET" && request.url === "/session-token") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(tokens.issue()));
      return;
    }
    // S6b-fix1 §5：GET /generated/<file>。文件名只允许 ^[a-z0-9_-]+\.png$，其它一律 404（防路径穿越）。
    if (request.method === "GET" && request.url !== undefined) {
      const path = new URL(request.url, "http://localhost").pathname;
      const file = generatedFileFor(path);
      if (file !== null) {
        const full = join(generatedDir, file);
        if (!existsSync(full)) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        response.end(readFileSync(full));
        return;
      }
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!tokens.validate(url.searchParams.get("token"))) {
      logger({ ts: Date.now(), event: "upgrade_rejected", detail: { reason: "invalid_token" } });
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    let tooLarge = false;

    const send: SendFn = (message: ServerMessage) => {
      // sessionId → ws：ws_drop 关闭的是该会话所在连接。
      if (message.type === "session") sessionSockets.set(message.sessionId, ws);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    // send → ws：S6b §1 未知 characterId 时按 send 找到连接并关闭。
    socketSendMap.set(send, ws);

    ws.on("message", (raw) => {
      if (tooLarge) return;

      const bytes = messageBytes(raw);
      if (bytes > MAX_MESSAGE_BYTES) {
        tooLarge = true;
        logger({ ts: Date.now(), event: "message_too_large", detail: { bytes, limit: MAX_MESSAGE_BYTES } });
        ws.close(1009, "message_too_large");
        return;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw.toString());
      } catch {
        logger({ ts: Date.now(), event: "bad_message", detail: { reason: "json" } });
        return;
      }
      const parsed = parseClientMessage(parsedJson);
      if (!parsed.success) {
        logger({ ts: Date.now(), event: "bad_message", detail: { reason: parsed.error.issues[0]?.message } });
        return;
      }

      // 心跳回复在传输层完成：即使会话不存在也回 pong。
      if (parsed.data.type === "ping") {
        send({
          v: 1,
          sessionId: parsed.data.sessionId,
          turnId: parsed.data.turnId,
          seq: parsed.data.seq,
          ts: Date.now(),
          type: "pong",
          payload: {},
        });
        return;
      }

      void sessions.handleMessage(send, parsed.data).catch((error: unknown) => {
        logger({
          ts: Date.now(),
          sessionId: parsed.data.sessionId,
          turnId: parsed.data.turnId,
          event: "handler_failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    });

    ws.on("error", (error) => {
      logger({ ts: Date.now(), event: "ws_error", detail: error.message });
    });

    ws.on("close", () => {
      for (const [sessionId, socket] of sessionSockets) {
        if (socket === ws) sessionSockets.delete(sessionId);
      }
      for (const [fn, socket] of socketSendMap) {
        if (socket === ws) socketSendMap.delete(fn);
      }
    });
  });

  const port = options.port ?? config.port;
  const listening = Promise.withResolvers<void>();
  httpServer.once("error", listening.reject);
  httpServer.listen(port, () => listening.resolve());
  await listening.promise;

  const address = httpServer.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  logger({ ts: Date.now(), event: "server_started", detail: { port: boundPort, providerMode: config.providerMode } });

  return {
    port: boundPort,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      sessions.dispose();
      const closed = Promise.withResolvers<void>();
      httpServer.close((error) => (error ? closed.reject(error) : closed.resolve()));
      await closed.promise;
    },
  };
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  // 直接运行（pnpm dev / start）时把仓库根 .env 补进进程环境；被测试/冒烟 import 时不读。
  applyRepoEnv();
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
