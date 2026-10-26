import { parseServerMessage, type ClientMessage } from "@mira/protocol";
import { handleTtsAudio } from "./audio";
import { HEARTBEAT_INTERVAL_MS, isHeartbeatExpired, jitteredDelay } from "./heartbeat";
import { handleMediaReady } from "./storyMediaLink";
import { dispatch, getStageState, pushEvent, useConnectionStore, type ConnectionStatus } from "./store";

const SESSION_STORAGE_KEY = "mira.sessionId";
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

type ClientPayloads = {
  hello: { resumeSessionId?: string; faults?: string[] };
  text_input: { text: string };
  audio_input: { mime: string; dataBase64: string };
  interrupt: { interruptedTurnId: number };
  ping: Record<string, never>;
};

export type Connection = {
  connect(): void;
  disconnect(): void;
  sendText(text: string): void;
  sendAudio(mime: string, dataBase64: string): void;
  sendInterrupt(interruptedTurnId: number): void;
};

function readStoredSessionId(): string | undefined {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeSessionId(sessionId: string): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch {
    // 隐私模式下 sessionStorage 可能不可用：仅内存保存。
  }
}

/** Q11：`?fail=tts,slow` → hello.payload.faults；空/非法值按未配置处理。 */
export function readUrlFaults(search: string): string[] | undefined {
  const raw = new URLSearchParams(search).get("fail");
  if (!raw) return undefined;
  const faults = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return faults.length > 0 ? faults : undefined;
}

function setStatus(status: ConnectionStatus): void {
  useConnectionStore.setState({ status });
}

export function createConnection(): Connection {
  let socket: WebSocket | null = null;
  let seq = 0;
  let attempt = 0;
  let reconnectTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  let lastPongAt = 0;
  let requestingToken = false;
  let closed = false;

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat(active: WebSocket): void {
    stopHeartbeat();
    lastPongAt = Date.now();
    heartbeatTimer = window.setInterval(() => {
      if (socket !== active) return;
      if (isHeartbeatExpired(lastPongAt, Date.now())) {
        pushEvent("heartbeat timeout → reconnect");
        stopHeartbeat();
        active.close();
        return;
      }
      sendEnvelope("ping", {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** 握手令牌（D8 复核 · Q12）：连接前先取，缺失或过期由服务端 401 拒绝升级。 */
  async function fetchSessionToken(): Promise<string | null> {
    try {
      const response = await fetch("/session-token");
      if (!response.ok) {
        console.warn(`[ws] 令牌请求失败：${response.status}`);
        return null;
      }
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("token" in body)) return null;
      return typeof body.token === "string" ? body.token : null;
    } catch (error) {
      console.warn("[ws] 令牌请求异常", error);
      return null;
    }
  }

  function sendEnvelope<T extends keyof ClientPayloads>(type: T, payload: ClientPayloads[T]): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn(`[ws] 未连接，丢弃 ${type}`);
      return;
    }
    // turnId 一律取 store 的 currentTurnId（D12：客户端分配）。
    const message = {
      v: 1,
      sessionId: useConnectionStore.getState().sessionId ?? "",
      turnId: getStageState().currentTurnId,
      seq,
      ts: Date.now(),
      type,
      payload,
    } as ClientMessage;
    seq += 1;
    socket.send(JSON.stringify(message));
  }

  function handleMessage(raw: string): void {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      console.warn("[ws] 非 JSON 消息，丢弃");
      return;
    }
    const parsed = parseServerMessage(parsedJson);
    if (!parsed.success) {
      console.warn("[ws] 非法 ServerMessage，丢弃", parsed.error.message);
      return;
    }

    const message = parsed.data;
    dispatch({ type: "SERVER_MESSAGE", message });

    if (message.type === "session") {
      useConnectionStore.setState({ sessionId: message.sessionId });
      storeSessionId(message.sessionId);
      // 恢复会话时 currentTurnId 的同步在 reducer 内完成（SERVER_MESSAGE + session），
      // 这里不再直接写 stage store（D4：唯一写入口是 reducer）。
    }
    if (message.type === "tts_audio") handleTtsAudio(message);
    // D27：media_ready 是剧情层消息，不经过 A 的 turnId 过滤，直接进 C。
    if (message.type === "media_ready") handleMediaReady(message);
    if (message.type === "pong") lastPongAt = Date.now();
    pushEvent(`recv ${message.type} t${message.turnId}`);
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    setStatus("reconnecting");
    const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 10_000;
    const wait = jitteredDelay(base, Math.random());
    attempt += 1;
    pushEvent(`reconnect in ${wait}ms`);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
  }

  function connect(): void {
    if (requestingToken) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    closed = false;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");

    requestingToken = true;
    void fetchSessionToken().then((token) => {
      requestingToken = false;
      if (closed) return;
      if (token === null) {
        scheduleReconnect();
        return;
      }

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const nextSocket = new WebSocket(
        `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`,
      );
      socket = nextSocket;

      nextSocket.addEventListener("open", () => {
        attempt = 0;
        setStatus("open");
        pushEvent("ws open");
        startHeartbeat(nextSocket);
        const faults = readUrlFaults(location.search);
        sendEnvelope(
          "hello",
          faults ? { resumeSessionId: readStoredSessionId(), faults } : { resumeSessionId: readStoredSessionId() },
        );
      });
      nextSocket.addEventListener("message", (event) => {
        if (typeof event.data === "string") handleMessage(event.data);
      });
      nextSocket.addEventListener("close", () => {
        if (socket === nextSocket) socket = null;
        stopHeartbeat();
        pushEvent("ws close");
        scheduleReconnect();
      });
      nextSocket.addEventListener("error", () => {
        console.warn("[ws] 连接错误");
        nextSocket.close();
      });
    });
  }

  return {
    connect,
    disconnect() {
      closed = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopHeartbeat();
      socket?.close();
      socket = null;
    },
    sendText(text) {
      sendEnvelope("text_input", { text });
    },
    sendAudio(mime, dataBase64) {
      sendEnvelope("audio_input", { mime, dataBase64 });
    },
    sendInterrupt(interruptedTurnId) {
      sendEnvelope("interrupt", { interruptedTurnId });
    },
  };
}
