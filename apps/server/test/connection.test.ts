import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { parseServerMessage, type ServerMessage } from "@mira/protocol";
import { MAX_MESSAGE_BYTES, startServer, type ServerHandle } from "../src/index";
import { silentLogger, type LogRecord } from "../src/log";
import { SESSION_TOKEN_TTL_MS } from "../src/tokens";

const handles: ServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

async function start(logger?: (record: LogRecord) => void): Promise<ServerHandle> {
  const server = await startServer({ port: 0, logger: logger ?? silentLogger });
  handles.push(server);
  return server;
}

function readToken(body: unknown): string {
  if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string") {
    throw new Error("令牌响应缺 token 字段");
  }
  return body.token;
}

async function fetchToken(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/session-token`);
  return readToken(await response.json());
}

function open(port: number, query: string): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  socket.once("open", () => resolve(socket));
  socket.once("error", reject);
  socket.once("unexpected-response", (_request, response) =>
    reject(new Error(`升级被拒：${response.statusCode}`)),
  );
  return promise;
}

function rejectedStatus(port: number, query: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  socket.once("unexpected-response", (_request, response) => {
    resolve(response.statusCode ?? 0);
    response.resume();
    socket.terminate();
  });
  socket.once("open", () => reject(new Error("缺失/无效令牌不应升级成功")));
  socket.once("error", reject);
  return promise;
}

/** 真实 WS 事件驱动：只等消息，不睡固定时长（超时交给 vitest 的 testTimeout）。 */
function waitMessage(socket: WebSocket, predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<ServerMessage>();
  function onMessage(raw: WebSocket.RawData): void {
    const parsed = parseServerMessage(JSON.parse(raw.toString()));
    if (!parsed.success) {
      socket.off("message", onMessage);
      reject(new Error(`非法 ServerMessage：${parsed.error.message}`));
      return;
    }
    if (!predicate(parsed.data)) return;
    socket.off("message", onMessage);
    resolve(parsed.data);
  }
  socket.on("message", onMessage);
  return promise;
}

function waitClose(socket: WebSocket): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  socket.once("close", (code) => resolve(code));
  socket.once("error", reject);
  return promise;
}

const ENVELOPE = { v: 1, sessionId: "", turnId: 0, seq: 0, ts: 0 } as const;

describe("握手令牌（Q12）", () => {
  it("GET /session-token 返回随机令牌与 30 分钟过期时间", async () => {
    const server = await start();
    const before = Date.now();
    const response = await fetch(`http://127.0.0.1:${server.port}/session-token`);
    const body: unknown = await response.json();
    const first = readToken(body);
    if (typeof body !== "object" || body === null || !("expiresAt" in body) || typeof body.expiresAt !== "number") {
      throw new Error("缺少 expiresAt");
    }
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + SESSION_TOKEN_TTL_MS - 1_000);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_TOKEN_TTL_MS + 1_000);

    const second = await fetchToken(server.port);
    expect(second).not.toBe(first);
  });

  it("缺失令牌 → 401，无效令牌 → 401", async () => {
    const server = await start();
    expect(await rejectedStatus(server.port, "")).toBe(401);
    expect(await rejectedStatus(server.port, "?token=nope")).toBe(401);
  });

  it("有效令牌可以升级并完成 hello", async () => {
    const server = await start();
    const socket = await open(server.port, `?token=${encodeURIComponent(await fetchToken(server.port))}`);
    try {
      const session = waitMessage(socket, (message) => message.type === "session");
      socket.send(JSON.stringify({ ...ENVELOPE, type: "hello", payload: {} }));
      expect((await session).type).toBe("session");
    } finally {
      socket.close();
    }
  });
});

describe("心跳与消息上限（D8 复核）", () => {
  it("ping → pong，即使没有 hello 也回复", async () => {
    const server = await start();
    const socket = await open(server.port, `?token=${encodeURIComponent(await fetchToken(server.port))}`);
    try {
      const pong = waitMessage(socket, (message) => message.type === "pong");
      socket.send(JSON.stringify({ ...ENVELOPE, seq: 7, type: "ping", payload: {} }));
      expect(await pong).toMatchObject({ type: "pong", seq: 7, payload: {} });
    } finally {
      socket.close();
    }
  });

  it(`超过 ${MAX_MESSAGE_BYTES} 字节 → 1009 关闭并写日志`, async () => {
    const records: LogRecord[] = [];
    const server = await start((record) => records.push(record));
    const socket = await open(server.port, `?token=${encodeURIComponent(await fetchToken(server.port))}`);
    const closed = waitClose(socket);

    const huge = JSON.stringify({
      ...ENVELOPE,
      type: "text_input",
      payload: { text: "x".repeat(MAX_MESSAGE_BYTES) },
    });
    expect(huge.length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    socket.send(huge);

    expect(await closed).toBe(1009);
    expect(records.some((record) => record.event === "message_too_large")).toBe(true);
  });
});
