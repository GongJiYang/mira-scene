import { parseServerMessage, type ClientMessage } from "@mira/protocol";
import { handleTtsAudio, setPlaybackStartedReporter } from "./audio";
import { HEARTBEAT_INTERVAL_MS, isHeartbeatExpired, jitteredDelay } from "./heartbeat";
import { handleMediaReady, handleMediaRequest } from "./storyMediaLink";
import { dispatch, getStageState, pushEvent, useConnectionStore, type ConnectionStatus } from "./store";
import { currentChannelId } from "../live/channel";
import { recordFirstAudioMs } from "../obs/hud";

const SESSION_STORAGE_KEY = "mira.sessionId";
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

type ClientPayloads = {
  hello: { resumeSessionId?: string; characterId?: string; faults?: string[] };
  text_input: { text: string };
  audio_input: { mime: string; dataBase64: string };
  interrupt: { interruptedTurnId: number };
  nudge: Record<string, never>;
  playback_started: { turnId: number; seq: number; clientMs: number };
  ping: Record<string, never>;
};

export type Connection = {
  connect(): void;
  disconnect(): void;
  sendText(text: string): void;
  sendAudio(mime: string, dataBase64: string): void;
  sendInterrupt(interruptedTurnId: number): void;
  /**
   * D32：主动开口；turnId 取当前轮次（发送前客户端已 dispatch NUDGE）。
   * 可选，便于既有测试里的假连接不必补齐。
   */
  sendNudge?(): void;
  /**
   * S6b §4：切换频道。结束当前会话（不保留聊天记录），以新 characterId 重新 hello。
   * 复用同一条连接：服务端按新的 characterId 建新会话。
   */
  switchCharacter?(characterId: string): void;
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

/** S6b §4：切频道不保留聊天记录 —— 丢掉旧会话 id，下次 hello 会新建会话。 */
function clearStoredSessionId(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // 隐私模式下 sessionStorage 可能不可用：忽略。
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

/**
 * S6b-fix1 §3：切频道后的消息过滤（纯函数，便于单测）。
 * - `awaitingSession`：等待新会话的 session 消息。期间 session 锁定新 id；
 *   S6b-fix2 §1：pong（传输层心跳）一律接受，error（如 unknown_character）接受并结束等待，
 *   其余带旧 sessionId 的消息仍丢弃。
 * - S6b-fix3 §1：等待期间放行的 error 只对会话级（scope === "session"）生效；
 *   轮次级 error 与本轮无关，不能让客户端卡住或误入错误态，仍按旧消息丢弃。
 * - 已锁定 sessionId 后：sessionId 不一致的消息一律丢弃（pong 是传输层心跳，不过滤）。
 */
export function shouldAcceptMessage(
  awaitingSession: boolean,
  knownSessionId: string | null,
  message: { type: string; sessionId: string; scope?: string },
): "accept" | "lock" | "drop" {
  if (awaitingSession) {
    if (message.type === "session") return "lock";
    if (message.type === "pong") return "accept";
    if (message.type === "error" && message.scope === "session") return "accept";
    return "drop";
  }
  if (knownSessionId !== null && message.type !== "pong" && message.sessionId !== knownSessionId) return "drop";
  return "accept";
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
  // S6b-fix1 §3：切频道后「等待新会话」——收到新 hello 的 session 消息前，
  // 任何带旧 sessionId 的消息都丢弃（不再 storeSessionId，也不进 reducer）。
  let awaitingSession = false;

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

  // §6：音频层在第一个 beat 开始播放时通过这里上报 playback_started。
  setPlaybackStartedReporter((turnId, beatSeq, clientMs) => {
    // S6h §3：旁路给 ?hud=1 角标（客户端自测首包延迟）。
    recordFirstAudioMs(clientMs);
    sendEnvelope("playback_started", { turnId, seq: beatSeq, clientMs });
  });

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

    // S6b-fix1 §3：切频道等待新会话期间，session 消息锁定新 sessionId；
    // 之后任何 sessionId 不一致的消息一律丢弃（记调试事件），不再 storeSessionId。
    // S6b-fix2 §1：等待期间 pong 一律接受（不断线）；error 接受并结束等待——
    // 服务端拒绝本次 hello（如 unknown_character）时客户端进入错误态而不是卡住。
    // S6b-fix3 §1：放行的 error 只对会话级生效（scope === "session"），
    // 轮次级 error 与本次 hello 无关，不能结束等待。
    if (awaitingSession && message.type === "error" && message.payload.scope === "session") {
      awaitingSession = false;
    }
    const scope = message.type === "error" ? message.payload.scope : undefined;
    const verdict = shouldAcceptMessage(awaitingSession, useConnectionStore.getState().sessionId, {
      type: message.type,
      sessionId: message.sessionId,
      scope,
    });
    if (verdict === "drop") {
      pushEvent(`drop stale message ${message.type}`);
      return;
    }
    if (verdict === "lock") {
      awaitingSession = false;
      useConnectionStore.setState({ sessionId: message.sessionId });
      storeSessionId(message.sessionId);
      dispatch({ type: "SERVER_MESSAGE", message });
      pushEvent(`recv ${message.type} t${message.turnId}`);
      return;
    }

    dispatch({ type: "SERVER_MESSAGE", message });

    if (message.type === "session") {
      useConnectionStore.setState({ sessionId: message.sessionId });
      storeSessionId(message.sessionId);
      // 恢复会话时 currentTurnId 的同步在 reducer 内完成（SERVER_MESSAGE + session），
      // 这里不再直接写 stage store（D4：唯一写入口是 reducer）。
    }
    if (message.type === "tts_audio") handleTtsAudio(message);
    // D27：带 media 的 beat 一到就登记 C 的显影请求（服务端已在异步生成）。
    if (message.type === "beat" && message.turnId === getStageState().currentTurnId) {
      const media = message.payload.beat.media;
      if (media?.storyEventId) handleMediaRequest(media.storyEventId, media.type);
    }
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
        // S6b §1：hello 带上当前频道；缺省时服务端按 rin 处理。
        const payload: ClientPayloads["hello"] = {
          resumeSessionId: readStoredSessionId(),
          characterId: currentChannelId(),
        };
        if (faults) payload.faults = faults;
        sendEnvelope("hello", payload);
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
    sendNudge() {
      sendEnvelope("nudge", {});
    },
    switchCharacter(characterId) {
      // S6b §4：结束当前会话（不保留聊天记录），以新角色重新 hello。
      // 复用同一条连接：服务端按新的 characterId 建新会话；旧会话由服务端空闲回收。
      // S6b-fix1 §3：标记「等待新会话」，收到新 session 前丢弃所有旧会话消息。
      clearStoredSessionId();
      useConnectionStore.setState({ sessionId: null });
      awaitingSession = true;
      const faults = readUrlFaults(location.search);
      const payload: ClientPayloads["hello"] = { characterId };
      if (faults) payload.faults = faults;
      sendEnvelope("hello", payload);
    },
  };
}
