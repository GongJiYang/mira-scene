import { randomUUID } from "node:crypto";
import {
  isTurnIdAcceptable,
  parseBeatLenient,
  type ClientMessage,
  type SceneState,
  type ServerMessage,
  type SessionPayload,
  type TranscriptPayload,
  type BeatPayload,
  type TtsAudioPayload,
  type TurnEndPayload,
  type StateSnapshotPayload,
  type ErrorPayload,
} from "@mira/protocol";
import { isAbortError, throwIfAborted } from "./abort";
import type { Logger } from "./log";
import type { LLMHistoryEntry, Ports } from "./ports";
import { advanceScene, applyBeatToScene, createInitialScene, evaluateStoryAdvance } from "./story";

export type SendFn = (message: ServerMessage) => void;

type TurnPayloads = {
  session: SessionPayload;
  transcript: TranscriptPayload;
  beat: BeatPayload;
  tts_audio: TtsAudioPayload;
  turn_end: TurnEndPayload;
  state_snapshot: StateSnapshotPayload;
  error: ErrorPayload;
};

type Session = {
  id: string;
  send: SendFn | null;
  history: LLMHistoryEntry[];
  scene: SceneState;
  lastTurnId: number;
  controller: AbortController | null;
  lastActiveAt: number;
  outSeq: number;
};

type InputMessage = Extract<ClientMessage, { type: "text_input" | "audio_input" }>;

export type SessionDeps = Ports & {
  log: Logger;
  now?: () => number;
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
};

export type SessionManager = {
  /** hello 会绑定该连接的 send；输入类消息的 Promise 在轮次结束后 resolve。 */
  handleMessage(send: SendFn, message: ClientMessage): Promise<void>;
  dispose(): void;
};

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

export function createSessionManager(deps: SessionDeps): SessionManager {
  const clock = deps.now ?? Date.now;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const sessions = new Map<string, Session>();

  function buildEnvelope<T extends keyof TurnPayloads>(
    session: Session,
    turnId: number,
    type: T,
    payload: TurnPayloads[T],
  ): ServerMessage {
    // 联合类型无法用泛型直接构造，字段由 TurnPayloads 与协议 schema 对齐。
    const message = {
      v: 1,
      sessionId: session.id,
      turnId,
      seq: session.outSeq,
      ts: clock(),
      type,
      payload,
    } as ServerMessage;
    session.outSeq += 1;
    return message;
  }

  function logFor(session: Session, turnId: number, event: string, detail?: unknown): void {
    deps.log({ ts: clock(), sessionId: session.id, turnId, event, detail });
  }

  /**
   * 单轮执行：LLM 流 → beat → 并发 TTS（发送按 seq 串行）→ snapshot → turn_end。
   * 每一次发送都经过「signal 未中止且 turnId === lastTurnId」守卫。
   */
  async function runTurn(session: Session, message: InputMessage, signal: AbortSignal): Promise<void> {
    const startedAt = clock();
    const turnId = message.turnId;
    const logTurn = (event: string, detail?: unknown) => {
      deps.log({ ts: clock(), sessionId: session.id, turnId, event, ms: clock() - startedAt, detail });
    };

    let closed = false;
    let failure: unknown = null;

    const emit = <T extends keyof TurnPayloads>(type: T, payload: TurnPayloads[T]): boolean => {
      if (closed || signal.aborted || session.lastTurnId !== turnId) return false;
      session.send?.(buildEnvelope(session, turnId, type, payload));
      return true;
    };
    // 终止消息（error / turn_end）不受 closed 影响，但仍受中止与轮次守卫约束。
    const emitFinal = <T extends keyof TurnPayloads>(type: T, payload: TurnPayloads[T]): boolean => {
      if (signal.aborted || session.lastTurnId !== turnId) return false;
      session.send?.(buildEnvelope(session, turnId, type, payload));
      return true;
    };

    logTurn("turn_start", { input: message.type });

    // 每个 beat 一出现就并发开始 TTS；通过 promise 链保证 tts_audio 按 seq 发送。
    let ttsChain: Promise<void> = Promise.resolve();
    const says: string[] = [];

    try {
      let userText: string;
      if (message.type === "audio_input") {
        const data = Buffer.from(message.payload.dataBase64, "base64");
        userText = await deps.stt.transcribe({ mime: message.payload.mime, data }, signal);
        throwIfAborted(signal);
        logTurn("stt_done", { text: userText });
        if (!emit("transcript", { text: userText })) return;
      } else {
        userText = message.payload.text;
      }

      let nextSeq = 0;
      let firstBeatSeen = false;
      let storyAdvanced = false;

      for await (const raw of deps.llm.streamBeats({ history: session.history, scene: session.scene, userText }, signal)) {
        if (signal.aborted || failure !== null) break;

        const parsed = parseBeatLenient(raw);
        if (parsed.warnings.length > 0) logTurn("beat_parse_warning", { warnings: parsed.warnings });
        const beat = { ...parsed.beat, seq: nextSeq };
        nextSeq += 1;

        const proposedAdvance = beat.story?.advance;
        if (proposedAdvance !== undefined) {
          if (storyAdvanced) {
            beat.story = null;
            logTurn("story_rejected", { advance: proposedAdvance, reason: "one_step_per_turn" });
          } else {
            const decision = evaluateStoryAdvance(session.scene, proposedAdvance);
            if (decision.ok) {
              session.scene = advanceScene(session.scene, decision.node);
              storyAdvanced = true;
            } else {
              beat.story = null;
              logTurn("story_rejected", { advance: proposedAdvance, reason: decision.reason });
            }
          }
        }

        session.scene = applyBeatToScene(session.scene, beat);

        if (!firstBeatSeen) {
          firstBeatSeen = true;
          logTurn("llm_first_beat", { seq: beat.seq });
        }
        if (!emit("beat", { beat })) return;
        logTurn("beat_sent", { seq: beat.seq, silent: beat.say === "" });

        if (beat.say !== "") {
          says.push(beat.say);
          const beatSeq = beat.seq;
          const audio = deps.tts.synthesize(beat.say, { emotion: beat.emotion }, signal).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          ttsChain = ttsChain.then(async () => {
            const result = await audio;
            if (failure !== null) return;
            if (!result.ok) {
              failure = result.error;
              return;
            }
            if (!emit("tts_audio", { beatSeq, mime: result.value.mime, dataBase64: result.value.data.toString("base64") })) return;
            logTurn("tts_done", { seq: beatSeq });
          });
        }
      }

      await ttsChain;
      if (signal.aborted) {
        logTurn("turn_aborted");
        return;
      }
      if (failure !== null) throw failure;

      closed = true;
      session.history.push({ role: "user", text: userText }, { role: "assistant", text: says.join("\n") });
      session.scene = { ...session.scene, turnCount: session.scene.turnCount + 1 };
      if (!emitFinal("state_snapshot", { snapshot: session.scene })) return;
      if (!emitFinal("turn_end", { reason: "done" })) return;
      logTurn("turn_end", { reason: "done" });
    } catch (error) {
      closed = true;
      // 等 TTS 链收尾，确保不会在 turn_end 之后又发出 tts_audio（链内发送已被 closed 拦截）。
      await ttsChain.catch(() => {});
      if (signal.aborted || isAbortError(error)) {
        logTurn("turn_aborted");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logTurn("turn_failed", { message });
      if (!emitFinal("error", { code: "turn_failed", message, retryable: true })) return;
      if (!emitFinal("turn_end", { reason: "error" })) return;
      logTurn("turn_end", { reason: "error" });
    }
  }

  function handleHello(send: SendFn, message: Extract<ClientMessage, { type: "hello" }>): void {
    const resumedId = message.payload.resumeSessionId;
    const existing = resumedId ? sessions.get(resumedId) : undefined;
    let session: Session;
    if (existing) {
      session = existing;
      logFor(session, session.lastTurnId, "session_resumed");
    } else {
      session = {
        id: randomUUID(),
        send: null,
        history: [],
        scene: createInitialScene(),
        lastTurnId: 0,
        controller: null,
        lastActiveAt: clock(),
        outSeq: 0,
      };
      sessions.set(session.id, session);
      logFor(session, 0, "session_created");
    }

    // 重连/重绑连接：旧连接上仍在跑的一轮没有意义，直接中止。
    session.controller?.abort();
    session.controller = null;
    session.send = send;
    session.lastActiveAt = clock();

    send(buildEnvelope(session, session.lastTurnId, "session", { snapshot: session.scene }));
  }

  function handleInterrupt(session: Session, message: Extract<ClientMessage, { type: "interrupt" }>): void {
    const interruptedTurnId = message.payload.interruptedTurnId;
    session.lastActiveAt = clock();
    if (interruptedTurnId !== session.lastTurnId || session.controller === null) {
      logFor(session, interruptedTurnId, "interrupt_ignored", { last: session.lastTurnId });
      return;
    }
    session.controller.abort();
    logFor(session, interruptedTurnId, "turn_aborted", { reason: "interrupt" });
  }

  async function handleInput(session: Session, message: InputMessage): Promise<void> {
    session.lastActiveAt = clock();

    if (!isTurnIdAcceptable(session.lastTurnId, message.turnId)) {
      logFor(session, message.turnId, "stale_turn", { incoming: message.turnId, last: session.lastTurnId });
      session.send?.(
        buildEnvelope(session, message.turnId, "error", {
          code: "stale_turn",
          message: `turnId ${message.turnId} 必须大于 ${session.lastTurnId}`,
          retryable: false,
        }),
      );
      return;
    }

    if (session.controller) {
      const supersededTurnId = session.lastTurnId;
      session.controller.abort();
      logFor(session, supersededTurnId, "turn_aborted", { reason: "superseded" });
    }

    session.lastTurnId = message.turnId;
    const controller = new AbortController();
    session.controller = controller;
    try {
      await runTurn(session, message, controller.signal);
    } finally {
      if (session.controller === controller) session.controller = null;
    }
  }

  async function handleMessage(send: SendFn, message: ClientMessage): Promise<void> {
    if (message.type === "hello") {
      handleHello(send, message);
      return;
    }

    const session = sessions.get(message.sessionId);
    if (!session) {
      deps.log({ ts: clock(), sessionId: message.sessionId, turnId: message.turnId, event: "unknown_session" });
      send({
        v: 1,
        sessionId: message.sessionId,
        turnId: message.turnId,
        seq: 0,
        ts: clock(),
        type: "error",
        payload: { code: "unknown_session", message: "会话不存在，请重新 hello", retryable: true },
      });
      return;
    }
    session.send ??= send;

    if (message.type === "interrupt") {
      handleInterrupt(session, message);
      return;
    }
    await handleInput(session, message);
  }

  const sweepTimer = setInterval(() => {
    const cutoff = clock() - idleTimeoutMs;
    for (const [id, session] of sessions) {
      if (session.lastActiveAt > cutoff) continue;
      session.controller?.abort();
      sessions.delete(id);
      logFor(session, session.lastTurnId, "session_expired");
    }
  }, deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  return {
    handleMessage,
    dispose() {
      clearInterval(sweepTimer);
      for (const session of sessions.values()) session.controller?.abort();
      sessions.clear();
    },
  };
}
