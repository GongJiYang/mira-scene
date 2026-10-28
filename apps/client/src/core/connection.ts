import { parseServerMessage, type ClientMessage } from "@mira/protocol";
import { handleTtsAudio, setPlaybackStartedReporter } from "./audio";
import { HEARTBEAT_INTERVAL_MS, isHeartbeatExpired, jitteredDelay } from "./heartbeat";
import { handleMediaReady, handleMediaRequest } from "./storyMediaLink";
import { handleSceneStatus } from "../live/scene/status";
import { applySessionRestore } from "../live/sessionRestore";
import { recordTranscript } from "../live/transcriptStore";
import { dispatch, getStageState, pushEvent, useConnectionStore, type ConnectionStatus } from "./store";
import { currentChannelId } from "../live/channel";
import { currentSettings, helloKeysFrom, resolveRequestedMode, SETTINGS_TEXT, useSettingsStore } from "../live/settings";
import { recordFirstAudioMs } from "../obs/hud";
import { useFallbackStore } from "./fallback";

const SESSION_STORAGE_KEY = "mira.sessionId";
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

/** D49 / S6n §2：hello 的 keys 载荷类型。 */
type HelloKeys = {
  deepseek?: { apiKey: string };
  fish?: { apiKey: string; voiceId?: string };
  image?: { apiKey: string; baseUrl: string; model?: string };
};

type ClientPayloads = {
  hello: { resumeSessionId?: string; characterId?: string; faults?: string[]; mode?: "mock" | "real" | "auto"; keys?: HelloKeys };
  text_input: { text: string; kind?: "text" | "poke" | "gift" };
  audio_input: { mime: string; dataBase64: string };
  interrupt: { interruptedTurnId: number };
  nudge: Record<string, never>;
  playback_started: { turnId: number; seq: number; clientMs: number };
  ping: Record<string, never>;
};

export type Connection = {
  connect(): void;
  disconnect(): void;
  sendText(text: string, kind?: "text" | "poke" | "gift"): void;
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
  /**
   * D49 / S6n §2：切换模式 = 新会话。清掉 `mira.sessionId` 后按当前设置重新 hello。
   */
  newSession?(): void;
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
  // D49 / S6n §2：real_unavailable 后本次重连用 mock（只回落一次）。
  let fallbackToMock = false;

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

    // D49 / S6n §2：显式 real 缺 Key → 服务端回 real_unavailable；客户端提示后自动回落 mock 重新建会话。
    if (message.type === "error" && message.payload.code === "real_unavailable") {
      pushEvent("real_unavailable → 回落 mock");
      // 提示文字（铁律 6：文案来自 uiText；这里经 fallback 字幕区显示）。
      useFallbackStore.setState({ subtitle: SETTINGS_TEXT.realUnavailable });
      // 本次重连用 mock；只回退一次（避免每次 hello 都真）。
      fallbackToMock = true;
      // 重开会话：丢掉旧 sessionId，重新 hello。
      clearStoredSessionId();
      useConnectionStore.setState({ sessionId: null });
      awaitingSession = true;
      socket?.close();
      return;
    }

    // D49 / S6n §3：Fish 4xx 音色错误 → 提示引导访客在设置里填自己的音色 ID（不静默降级）。
    if (message.type === "error" && message.payload.code === "voice_unavailable") {
      useFallbackStore.setState({ subtitle: SETTINGS_TEXT.voiceUnavailable });
    }

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
      useConnectionStore.setState({ sessionId: message.sessionId, startedAt: message.type === "session" ? (message.payload.startedAt ?? null) : null });
      storeSessionId(message.sessionId);
      dispatch({ type: "SERVER_MESSAGE", message });
      if (message.type === "session") applySessionRestore(message.payload);
      pushEvent(`recv ${message.type} t${message.turnId}`);
      return;
    }

    dispatch({ type: "SERVER_MESSAGE", message });

    if (message.type === "session") {
      useConnectionStore.setState({ sessionId: message.sessionId, startedAt: message.payload.startedAt ?? null });
      storeSessionId(message.sessionId);
      // D49 / S6n §2：记录本会话实际生效的模式与能力来源（顶栏标签 / 设置面板来源标签用）。
      if (message.payload.mode !== undefined && message.payload.capabilities !== undefined) {
        useSettingsStore.getState().applySession(message.payload.mode, message.payload.capabilities);
      }
      // 会话建立后清掉一次性回落标记（下次重连按设置走）。
      fallbackToMock = false;
      // S6l-fix1 §2：恢复会话时把服务端下发的背景与对话记录落到客户端（刷新恢复）。
      applySessionRestore(message.payload);
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
    // S6c §5：scene_status 也是剧情层消息，不经过 A 的 turnId 过滤。
    if (message.type === "scene_status") handleSceneStatus(message.payload);
    if (message.type === "pong") lastPongAt = Date.now();
    // freeze-fix9 §3：语音识别结果进弹幕区（只记当前轮的，旧轮 D3 丢弃 —— Live 排空时再校验轮次）。
    if (message.type === "transcript") recordTranscript(message.turnId, message.payload.text);
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
        // D49 / S6n §2：hello 带上模式与访问者自带的 Key（空 Key 不发送）。
        const payload: ClientPayloads["hello"] = {
          resumeSessionId: readStoredSessionId(),
          characterId: currentChannelId(),
          // real_unavailable 后的这次重连强制 mock；否则按设置。
          mode: fallbackToMock ? "mock" : resolveRequestedMode(currentSettings()),
        };
        if (!fallbackToMock) {
          const keys = helloKeysFrom(currentSettings());
          if (keys !== undefined) payload.keys = keys;
        }
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
    sendText(text, kind) {
      sendEnvelope("text_input", kind === undefined ? { text } : { text, kind });
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
      const mode = resolveRequestedMode(currentSettings());
      payload.mode = mode;
      const keys = helloKeysFrom(currentSettings());
      if (keys !== undefined) payload.keys = keys;
      if (faults) payload.faults = faults;
      sendEnvelope("hello", payload);
    },
    /**
     * D49 / S6n §2：切换模式 = 新会话。清掉 `mira.sessionId` 后按当前设置重新 hello。
     * 与 `switchCharacter` 同一路径，只是保留当前频道。
     */
    newSession() {
      clearStoredSessionId();
      useConnectionStore.setState({ sessionId: null });
      awaitingSession = true;
      const faults = readUrlFaults(location.search);
      const payload: ClientPayloads["hello"] = {
        characterId: currentChannelId(),
        mode: resolveRequestedMode(currentSettings()),
      };
      const keys = helloKeysFrom(currentSettings());
      if (keys !== undefined) payload.keys = keys;
      if (faults) payload.faults = faults;
      sendEnvelope("hello", payload);
    },
  };
}
