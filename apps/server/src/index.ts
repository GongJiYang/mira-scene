import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, type ServerMessage } from "@mira/protocol";
import { createMockLlm } from "./adapters/mock/mockLlm";
import { createMockStt } from "./adapters/mock/mockStt";
import { createMockTts } from "./adapters/mock/mockTts";
import { loadConfig } from "./config";
import { consoleLogger } from "./log";
import { createSessionManager, type SendFn } from "./session";

export type ServerHandle = {
  port: number;
  close(): Promise<void>;
};

export type StartServerOptions = {
  /** 默认取 config.port（8787）；冒烟脚本传 0 使用随机端口。 */
  port?: number;
};

/**
 * 进程内启动：GET /health → {ok:true}；WebSocket 只升级 /ws。
 */
export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const config = loadConfig();
  const logger = consoleLogger;
  const sessions = createSessionManager({
    stt: createMockStt(),
    llm: createMockLlm(),
    tts: createMockTts(),
    log: logger,
  });

  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
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
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const send: SendFn = (message: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };

    ws.on("message", (raw) => {
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
