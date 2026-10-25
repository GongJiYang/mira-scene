import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { parseClientMessage, type ServerMessage } from "@mira/protocol";
import { createMockLlm } from "./adapters/mock/mockLlm";
import { createMockStt } from "./adapters/mock/mockStt";
import { createMockTts } from "./adapters/mock/mockTts";
import { loadConfig } from "./config";
import { consoleLogger, type Logger } from "./log";
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
  const config = loadConfig();
  const logger = options.logger ?? consoleLogger;
  const tokens = createTokenStore();
  const sessions = createSessionManager({
    stt: createMockStt(),
    llm: createMockLlm(),
    tts: createMockTts(),
    log: logger,
    sessionTurnLimit: config.sessionTurnLimit,
    dailyTurnLimit: config.dailyTurnLimit,
  });

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
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };

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
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
