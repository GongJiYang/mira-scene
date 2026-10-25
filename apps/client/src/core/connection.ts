import { parseServerMessage, type ClientMessage } from "@mira/protocol";
import { handleTtsAudio } from "./audio";
import { dispatch, getStageState, pushEvent, useConnectionStore, type ConnectionStatus } from "./store";

const SESSION_STORAGE_KEY = "mira.sessionId";
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

type ClientPayloads = {
  hello: { resumeSessionId?: string };
  text_input: { text: string };
  audio_input: { mime: string; dataBase64: string };
  interrupt: { interruptedTurnId: number };
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

function setStatus(status: ConnectionStatus): void {
  useConnectionStore.setState({ status });
}

export function createConnection(): Connection {
  let socket: WebSocket | null = null;
  let seq = 0;
  let attempt = 0;
  let reconnectTimer: number | null = null;
  let closed = false;

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
    pushEvent(`recv ${message.type} t${message.turnId}`);
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    setStatus("reconnecting");
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 10_000;
    attempt += 1;
    pushEvent(`reconnect in ${wait}ms`);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
  }

  function connect(): void {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    closed = false;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const nextSocket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket = nextSocket;

    nextSocket.addEventListener("open", () => {
      attempt = 0;
      setStatus("open");
      pushEvent("ws open");
      sendEnvelope("hello", { resumeSessionId: readStoredSessionId() });
    });
    nextSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") handleMessage(event.data);
    });
    nextSocket.addEventListener("close", () => {
      if (socket === nextSocket) socket = null;
      pushEvent("ws close");
      scheduleReconnect();
    });
    nextSocket.addEventListener("error", () => {
      console.warn("[ws] 连接错误");
      nextSocket.close();
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
