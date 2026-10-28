import { randomUUID } from "node:crypto";
import {
  isTurnIdAcceptable,
  parseLlmBeatLenient,
  throttleEvent,
  type Accent,
  type Action,
  type Beat,
  type ClientMessage,
  type Media,
  type MediaReadyPayload,
  type SceneState,
  type SceneStatusPayload,
  type ServerMessage,
  type SessionCapabilities,
  type SessionPayload,
  type TranscriptPayload,
  type BeatPayload,
  type TtsAudioPayload,
  type TurnEndPayload,
  type StateSnapshotPayload,
  type ErrorPayload,
} from "@mira/protocol";
import { DEFAULT_FIRST_TOKEN_TIMEOUT_MS, WS_DROP_AFTER_BEAT, parseFaults, shouldResume, withFaults, type Fault } from "./adapters/faults";
import { isFishApiError } from "./adapters/fish/errors";
import { isAbortError, throwIfAborted } from "./abort";
import { clientPublicRoot, defaultCharacterId, type FallbackCategory, type Pack } from "./characters/pack";
import { defaultOutDir } from "./adapters/media/imageGen";
import { direct, type DirectorContext } from "./director/director";
import { forcedAdvance } from "./director/forcedAdvance";
import { advanceAllowance, resolveIntent } from "./prompts/advanceRule";
import { countCare } from "./prompts/renderPrompt";
import type { Logger } from "./log";
import { redactSecrets } from "./obs/sanitize";
import type { LLMHistoryEntry, MediaPort, Ports, SceneWriterPort, TTSAudio, TTSPort, TtsOptions } from "./ports";
import type { HistorySource } from "./ports";
import type { BuiltProviders, RequestedMode, SessionPlan } from "./providers";
import { detectSceneRequest } from "./scene/detect";
import { resolveReferencePath, type ReferenceDirs } from "./scene/referencePath";
import { runSceneJob, type SceneRunnerDeps } from "./scene/runner";
import { initialSceneJobState, admitSceneJob, sceneJobReducer, type SceneJobState } from "./scene/job";
import { createInitialScene } from "./story";

export type SendFn = (message: ServerMessage) => void;

/** D32：主动开口轮固定的 user_text（客户端那一句没有说话）。 */
export const NUDGE_USER_TEXT = "（客人安静地坐着，没有说话）";

/**
 * S6c-fix1 §1：准入被拒时写进 `scene_notes` 的原因（不是台词，只是给 LLM 的提示）。
 * 与角色包的 `scene_busy` 兜底句配合使用，避免 LLM 回话与兜底句矛盾。
 */
const SCENE_REJECT_NOTE: Record<"cooldown" | "limit" | "busy", string> = {
  cooldown: "刚换过要等一会",
  limit: "今晚次数用完",
  busy: "上一个还没换完",
};

type TurnPayloads = {
  session: SessionPayload;
  transcript: TranscriptPayload;
  beat: BeatPayload;
  tts_audio: TtsAudioPayload;
  turn_end: TurnEndPayload;
  state_snapshot: StateSnapshotPayload;
  media_ready: MediaReadyPayload;
  scene_status: SceneStatusPayload;
  error: ErrorPayload;
};

type Session = {
  id: string;
  send: SendFn | null;
  /** S6b §1：本会话激活的角色包。 */
  pack: Pack;
  history: LLMHistoryEntry[];
  scene: SceneState;
  recentActions: readonly (Action | null)[];
  /** D47：最近 10 个产出 beat 的 accent（含 null），供导演层 accent 冷却判定。 */
  recentAccents: readonly (Accent | null)[];
  /** S6l §5：戳一下的累计次数（用于 poke 的 shy / angry 轮流）。 */
  pokeCount: number;
  /** §1：连续「已允许推进但 LLM 未推进」的真实用户轮数（推进后清零）。 */
  stalledUserTurns: number;
  /** §5.1：会话创建时刻（epoch ms），供顶栏显示真实开播时长；恢复会话沿用原值。 */
  startedAt: number;
  /** S6l-fix2 §6：上一次被接受的 poke / gift 时刻（服务端限流）。 */
  lastPokeAt: number | null;
  lastGiftAt: number | null;
  lastTurnId: number;
  /** 已接受的轮数（Q12 会话限额）。 */
  turnsUsed: number;
  controller: AbortController | null;
  lastActiveAt: number;
  outSeq: number;
  /** 本会话的端口（hello 时按 faults 包装，故障按会话生效）。 */
  ports: Ports;
  /** 本会话生效的故障（hello 的 faults，缺省取全局默认值）。 */
  faults: readonly Fault[];
  /** 最近一轮的起点（服务端时钟），用于 playback_started 计算 first_audio_ms。 */
  turnStartedAt: { turnId: number; at: number } | null;
  /** D27：已投递 / 已排期的剧情媒体事件，按 storyEventId 去重。 */
  mediaSent: Set<string>;
  /** D27：剧情媒体任务独立于轮次取消；dispose 时统一中止。 */
  mediaController: AbortController;
  /** S6b-fix1 §1：本会话角色的 TTS 音色（从 pack.voice.fishVoiceIdEnv 对应的环境变量解析）。 */
  voiceId?: string;
  /** S6c §4：本会话的换背景任务状态（冷却、次数上限、单任务）。 */
  sceneJob: SceneJobState;
  /** S6c §4：换背景任务的 AbortController（切频道时中止）。 */
  sceneController: AbortController;
  /** S6c §4：换背景端口（扩写 + 生图），由 index.ts 注入。 */
  sceneWriter?: SceneWriterPort;
  sceneImageGen?: SceneRunnerDeps["image"];
  sceneReferencePaths?: SceneRunnerDeps["referencePaths"];
  /** D49 / S6n §2：本会话实际生效的模式（`mock` 或 `real`）。 */
  mode: "mock" | "real";
  /** D49 / S6n §2：各类能力的来源（只说明来源，不含 Key）。 */
  capabilities: SessionCapabilities;
  /** D49 / S6n §3：访问者覆盖的 Fish 音色；非空时优先于角色包音色。 */
  voiceIdUser: string;
  /** D49 / S6n §2：剧情层媒体端口（随模式定，真实生图或预置照片）。 */
  media: MediaPort;
};

/** 一轮输入的规范化形式：文字 / 语音 / 主动开口（D32）。 */
type TurnInput =
  | { type: "text_input"; turnId: number; text: string; kind?: "text" | "poke" | "gift" }
  | { type: "audio_input"; turnId: number; mime: string; dataBase64: string }
  | { type: "nudge"; turnId: number };

export type SessionDeps = Ports & {
  log: Logger;
  now?: () => number;
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  /** 每会话最多轮数，默认 30。 */
  sessionTurnLimit?: number;
  /** 全站每天最多轮数，默认 300。 */
  dailyTurnLimit?: number;
  /** hello 时按本会话的 faults 创建端口；缺省复用 deps 上的端口实例。 */
  createPorts?: (faults: readonly Fault[]) => Ports;
  /** 环境变量 FAULTS 的全局默认值。 */
  defaultFaults?: readonly Fault[];
  /** LLM 首 token 超时（毫秒），默认 10s。 */
  firstTokenTimeoutMs?: number;
  /** `ws_drop`：由传输层关闭该会话的连接。 */
  dropConnection?: (sessionId: string) => void;
  /** S6b §1：hello 的 `characterId` 不合法时，由传输层关闭该连接（发完 error 后调用）。 */
  closeConnection?: (send: SendFn) => void;
  /** D27：媒体端口；缺省时用一个立即就绪的兜底实现（真实运行由 index.ts 注入预置照片适配器）。 */
  media?: MediaPort;
  /** S6b §1：角色包注册表（id → Pack）；由 index.ts 在启动时加载。 */
  packs?: Map<string, Pack>;
  /**
   * S6b-fix1 §1：按角色包解析 TTS 音色（从 pack.voice.fishVoiceIdEnv 对应环境变量取值）。
   * 由 index.ts 在启动时注入；真实模式下缺失会在启动时报错。Mock 模式返回 undefined。
   */
  resolveVoiceId?: (pack: Pack) => string | undefined;
  /** S6c §4：场景扩写端口（Mock 或真实）。 */
  sceneWriter?: SceneWriterPort;
  /** S6c §4：生图参数（不含 prompt / size / media / signal）。 */
  sceneImageGen?: SceneRunnerDeps["image"];
  /** S6c §4：参考图路径（当前背景）。 */
  sceneReferencePaths?: SceneRunnerDeps["referencePaths"];
  /**
   * S6l-fix1 §0：参考图路径解析用的目录（`/generated/` → 生成目录；其余 → 客户端静态目录）。
   * 缺省按当前进程环境解析（index.ts 不需额外注入）。
   */
  referenceDirs?: ReferenceDirs;
  /**
   * D49 / S6n §2：把 hello 的 `mode` / `keys` 解析成模式与 capabilities（纯函数）。
   * 缺省时一律按 mock 处理（旧测试无需提供）。
   */
  planSession?: (mode: RequestedMode, keys: import("@mira/protocol").HelloKeys | undefined) => SessionPlan;
  /**
   * D49 / S6n §1：按模式 + Key 组装适配器（工厂）。仅访问者自带 Key 的 real 会话会调用。
   */
  buildProviders?: (mode: "mock" | "real", keys: import("./providers").ProvidersKeys) => BuiltProviders;
  /**
   * D49 / S6n §1：全局共享的 Mock 适配器（无状态）；`auto`/`mock` 会话复用它，不重复构建。
   */
  mockProviders?: BuiltProviders;
};

export type SessionManager = {
  /** hello 会绑定该连接的 send；输入类消息的 Promise 在轮次结束后 resolve。 */
  handleMessage(send: SendFn, message: ClientMessage): Promise<void>;
  dispose(): void;
};

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_SESSION_TURN_LIMIT = 30;
const DEFAULT_DAILY_TURN_LIMIT = 300;

/** S6l-fix1 §1：transcript 只保留最近这么多条对话。 */
export const TRANSCRIPT_LIMIT = 40;

/**
 * S6l-fix1 §1：`session` 消息里除 snapshot 之外的恢复数据（纯函数，便于单测）。
 * - `background`：当前正在显示的生成背景（`sceneJob.currentBackground`）；没换过为 null。
 * - `transcript`：最近最多 `TRANSCRIPT_LIMIT` 条对话（user / assistant 原样，assistant 的多句按换行保留）。
 *
 * S6l-fix2 §5：`background` 读持久的 `currentBackground`（不再被一次性的 ready 提示清空）。
 */
export function resumePayload(session: {
  sceneJob: Pick<SceneJobState, "currentBackground">;
  history: readonly LLMHistoryEntry[];
}): {
  background: { label: string; urls: { desktop: string; mobile: string } } | null;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
} {
  const background = session.sceneJob.currentBackground ?? null;
  // S6l-fix2 §7：transcript 只含真实用户条目（user 来源），nudge / poke / gift 占位不进弹幕区。
  const recent = session.history.slice(-TRANSCRIPT_LIMIT);
  const transcript = recent
    .filter((entry) => entry.role !== "user" || (entry.source ?? "user") === "user")
    .map((entry) => ({ role: entry.role, text: entry.text }));
  return { background, transcript };
}

/** 自然日（本地时区）→ 用于每日限额重置。 */
function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * D49 / S6n §2：缺省（未注入 planSession）时的 mock 计划——旧测试与未配置模式的路径。
 * 不读任何 Key，capabilities 全 `none`。
 */
function defaultMockPlan(): SessionPlan {
  return {
    ok: true,
    mode: "mock",
    capabilities: { llm: "none", voice: "none", image: "none" },
    voiceIdUser: "",
    keys: {
      deepseek: { value: "", source: "none" },
      fish: { value: "", source: "none" },
      fishVoiceIdUser: "",
      image: { value: "", source: "none", baseUrl: "", model: "" },
    },
  };
}

/** D49 / S6n §2：real 缺 Key 时的说明文字（点名缺哪一类，客户端据此提示）。 */
function missingMessage(missing: ReadonlyArray<"llm" | "voice">): string {
  const names = missing.map((item) => (item === "llm" ? "聊天" : "语音"));
  return `真实模式缺少${names.join(" / ")}的 Key`;
}

type SynthOutcome = { ok: true; value: TTSAudio } | { ok: false; error: unknown };

/** 每句最多尝试 2 次（先重试 1 次）；中止不重试。 */
async function synthesizeWithRetry(
  tts: TTSPort,
  text: string,
  opts: TtsOptions,
  signal: AbortSignal,
): Promise<SynthOutcome> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { ok: true, value: await tts.synthesize(text, opts, signal) };
    } catch (error) {
      lastError = error;
      if (signal.aborted || isAbortError(error)) break;
      // D49 / S6n §3：音色 / 权限类 4xx 重试无意义（且不得省略 reference_id 重试）→ 立即返回。
      if (isFishApiError(error) && error.code === "fish_voice") break;
    }
  }
  return { ok: false, error: lastError };
}

/**
 * 降级兜底 beat（D10 / S6b §2）：只带台词与情绪，视觉沿用当前场景。
 * 台词从角色包的 fallback 表按类别取，不在此处硬编码（铁律 6）。
 */
function fallbackBeat(session: Session, category: FallbackCategory): Beat {
  return {
    seq: 0,
    say: session.pack.fallback[category],
    emotion: "guarded",
    accent: null,
    hands: session.scene.hands,
    action: null,
    camera: null,
    fx: null,
    media: null,
    story: null,
  };
}

export function createSessionManager(deps: SessionDeps): SessionManager {
  const clock = deps.now ?? Date.now;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const sessionTurnLimit = deps.sessionTurnLimit ?? DEFAULT_SESSION_TURN_LIMIT;
  const dailyTurnLimit = deps.dailyTurnLimit ?? DEFAULT_DAILY_TURN_LIMIT;
  const sessions = new Map<string, Session>();
  // S6b-fix1 §1：音色解析（按角色包）。缺省不解析（mock 旧行为）。
  const resolveVoiceId = deps.resolveVoiceId ?? (() => undefined);
  // D49 / S6n §2：模式 / Key → 模式与 capabilities（纯函数）。缺省一律 mock（旧测试无需提供）。
  const planFor = deps.planSession ?? defaultMockPlan;
  // D49 / S6n §1：全局共享 Mock 适配器（无状态）。auto/mock 会话复用它，不重复构建。
  const mockBuilt: BuiltProviders =
    deps.mockProviders ?? {
      ports: { stt: deps.stt, llm: deps.llm, tts: deps.tts },
      sceneWriter: deps.sceneWriter ?? { write: async () => "" },
      sceneImageGen: deps.sceneImageGen,
      media:
        deps.media ??
        { preset: (item) => Promise.resolve({ url: `/stage/photos/${item.id}.png`, status: "ready" as const }) },
    };
  /** §1：mock 复用共享适配器；real 且访问者自带 Key → 为该会话单独构建。 */
  function resolveBuilt(plan: Extract<SessionPlan, { ok: true }>): BuiltProviders {
    if (plan.mode === "mock") return mockBuilt;
    return deps.buildProviders ? deps.buildProviders(plan.mode, plan.keys) : mockBuilt;
  }
  // S6l-fix1 §0：参考图路径解析目录。生成目录优先用生图配置里的 outDir（与落盘位置一致），
  // 否则按进程环境解析；客户端静态根固定。
  const referenceDirs: ReferenceDirs =
    deps.referenceDirs ?? {
      generatedDir: deps.sceneImageGen?.outDir ?? defaultOutDir(),
      clientPublicRoot: clientPublicRoot(),
    };
  // 全站每日计数：内存保存，跨自然日重置。
  const daily = { day: localDayKey(clock()), count: 0 };

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

  /** 尚未建会话时的日志（hello 阶段用；只带信封里的 sessionId / turnId）。 */
  function logFor2(sessionId: string, turnId: number, event: string, detail?: unknown): void {
    deps.log({ ts: clock(), sessionId, turnId, event, detail });
  }

  /**
   * D27：投递剧情层媒体。后台异步任务，**不绑定轮次、不随打断中止**（有意为之的例外）：
   * 打断后仍然送达，只按 storyEventId 去重。
   */
  function scheduleMediaDelivery(session: Session, turnId: number, media_: Media, storyEventId: string): void {
    if (session.mediaSent.has(storyEventId)) return;
    session.mediaSent.add(storyEventId);
    logFor(session, turnId, "media_scheduled", { storyEventId });
    // S6b-fix1 §4：传入当前角色包与最近对话，让生图提示词用到本轮之前的对话内容。
    // 快照 history：后台任务异步完成时本轮历史已追加，快照保证「本轮之前」的语义。
    const ctx = { pack: session.pack, history: [...session.history] };
    void (async () => {
      try {
        const result = await session.media.preset(media_, ctx, session.mediaController.signal);
        if (session.mediaController.signal.aborted) return;
        session.send?.(
          buildEnvelope(session, turnId, "media_ready", {
            storyEventId,
            media: { ...media_, url: result.url },
            status: result.status,
          }),
        );
        logFor(session, turnId, "media_ready_sent", { storyEventId, status: result.status });
      } catch (error) {
        if (isAbortError(error) || session.mediaController.signal.aborted) return;
        logFor(session, turnId, "media_failed", { storyEventId, message: redactSecrets(error instanceof Error ? error.message : String(error)) });
      }
    })();
  }

  /**
   * 单轮执行：LLM 流 → beat → 并发 TTS（发送按 seq 串行）→ snapshot → turn_end。
   * 每一次发送都经过「signal 未中止且 turnId === lastTurnId」守卫。
   */
  async function runTurn(session: Session, input: TurnInput, signal: AbortSignal): Promise<void> {
    const startedAt = clock();
    const turnId = input.turnId;
    // D32：主动开口轮。提示词追加沉默提示；禁止本轮推进剧情（因此不计入 trust）。
    const isNudge = input.type === "nudge";
    const logTurn = (event: string, detail?: unknown) => {
      deps.log({ ts: clock(), sessionId: session.id, turnId, event, ms: clock() - startedAt, detail });
    };
    // §6 计时：记录本轮起点，供 playback_started 计算 first_audio_ms。
    session.turnStartedAt = { turnId, at: startedAt };

    let closed = false;
    // 首 token 超时用独立 AbortController 中止 LLM，不污染本轮 turn signal（打断语义不变）。
    const llmAbort = new AbortController();
    const llmSignal = AbortSignal.any([signal, llmAbort.signal]);
    const firstTokenTimeoutMs = deps.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    let firstTokenTimer: NodeJS.Timeout | null = null;
    let llmTimedOut = false;
    let ttsDegraded = false;
    let ttsFirstLogged = false;
    // D49 / S6n §3：音色不可用后本轮不再发起新的 TTS（不静默降级、不换音色重试）。
    let voiceFailed = false;

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

    logTurn("turn_start", { input: input.type });

    // 每个 beat 一出现就并发开始 TTS；通过 promise 链保证 tts_audio 按 seq 发送。
    let ttsChain: Promise<void> = Promise.resolve();
    const says: string[] = [];

    try {
      let userText: string;
      if (input.type === "audio_input") {
        const data = Buffer.from(input.dataBase64, "base64");
        try {
          userText = await session.ports.stt.transcribe({ mime: input.mime, data }, signal);
        } catch (error) {
          if (signal.aborted || isAbortError(error)) throw error;
          // S6b §2：STT 抛其它错误（网络 / 超时 / 5xx）→ 说角色化的「信号断了一下」台词后正常结束本轮，
          // 不再走 turn_failed（不显示技术报错）。
          logTurn("fallback_used", { category: "stt_failed" });
          if (!emitFinal("beat", { beat: fallbackBeat(session, "stt_failed") })) return;
          closed = true;
          if (!emitFinal("turn_end", { reason: "done" })) return;
          logTurn("turn_end", { reason: "done" });
          return;
        }
        throwIfAborted(signal);
        logTurn("stt_done", { chars: [...userText].length });
        if (userText.trim() === "") {
          // STT 空结果：不跑 LLM，给一句「没听清」后正常结束本轮。
          logTurn("fallback_used", { category: "stt_empty" });
          if (!emit("beat", { beat: fallbackBeat(session, "stt_empty") })) return;
          closed = true;
          if (!emitFinal("turn_end", { reason: "done" })) return;
          logTurn("turn_end", { reason: "done" });
          return;
        }
        if (!emit("transcript", { text: userText })) return;
      } else if (isNudge) {
        // D32：主动开口。user_text 固定，动态后缀（在提示词里）追加一句沉默提示。
        userText = NUDGE_USER_TEXT;
        logTurn("nudge_turn");
      } else {
        userText = input.text;
      }

      // S6l §5：poke / gift 的情景说明（放 scene_notes，不当作用户台词）。
      const inputKind = input.type === "text_input" ? (input.kind ?? "text") : "text";
      const eventNote = inputKind === "poke" ? "观众戳了你一下" : inputKind === "gift" ? "观众送了你一个礼物" : undefined;
      // poke / gift 的占位 user_text 不应该被当成观众说的话；用一句中性的场景描述。
      if (eventNote !== undefined) userText = "（观众做出了一个动作，没有说话）";

      let nextSeq = 0;
      let firstBeatSeen = false;
      let beatsSent = 0;
      // S6l §5：poke 的序号（本轮开始前的累计次数），用于 shy / angry 轮流。
      const pokeIndex = session.pokeCount;
      if (inputKind === "poke") session.pokeCount += 1;
      let directorCtx: DirectorContext = {
        scene: session.scene,
        recentActions: session.recentActions,
        recentAccents: session.recentAccents,
        // 主动开口轮禁止推进剧情：不计入 trust（D32）。
        advancedThisTurn: isNudge,
        beatsThisTurn: 0,
        // S6g-A §2：视觉（镜头 / 特效 / 媒体）只来自角色包节点表。
        nodeVisuals: session.pack.nodeVisuals,
        // S6l §5：poke / gift 的 accent 规则与 gift 的 fx hearts。
        inputKind,
        pokeIndex,
      };

      // §1：导演层保底推进。规则允许进入下一节点后，若 LLM 连续 2 个真实用户轮仍未推进，
      // 或本轮 ask_core / comfort 命中，则在本轮第一个 beat 上强制推进（走 story.ts 校验）。
      // 只数真实用户轮（source === "user"）；nudge / poke / gift 不计数。
      const isRealUserTurn = !isNudge && inputKind === "text";
      const intent = resolveIntent(session.pack, userText);
      const care = countCare(session.pack, session.history, userText);
      const userTurns = session.history.filter(
        (entry) => entry.role === "user" && (entry.source ?? "user") === "user",
      ).length;
      const allowedNode = advanceAllowance(
        { ...session.scene, trust: care },
        intent,
        session.scene.turnCount,
        userTurns,
      );
      const forceNow = allowedNode !== null && (intent === "ask_core" || intent === "comfort");
      // 注意：这里不知道本轮 LLM 会不会自己推进，故先按「未推进」算出基线计数；
      // 若本轮最终推进了（LLM 或强制），在末尾把计数清零（见 nodeBefore 比较）。
      const forced = forcedAdvance({
        allowed: allowedNode,
        advancedThisTurn: false,
        stalledUserTurns: session.stalledUserTurns,
        isRealUserTurn,
        forceNow,
      });
      const forcedNode = forced.force;
      const nodeBefore = session.scene.node;

      // S6c §1：弹幕命中「换背景」→ 照常回话，并在后台启动场景任务。
      let sceneNotes: string | undefined;
      // S6c §5：上一轮 ready 后，本轮 scene_notes 加「背景已经换成 {label}」。
      // S6l-fix2 §5：这是一次性提示（pendingReadyNote），用完清空；当前背景名（currentBackground）保留。
      if (session.sceneJob.pendingReadyNote !== undefined) {
        sceneNotes = session.sceneJob.pendingReadyNote;
        session.sceneJob.pendingReadyNote = undefined;
      }
      // S6c-fix1 §2：上一轮失败 / 被拒 → 本轮 scene_notes 加一句「刚才背景没换成」。
      if (session.sceneJob.lastFailed === true) {
        sceneNotes = sceneNotes === undefined ? "刚才背景没换成" : `${sceneNotes}。刚才背景没换成`;
        session.sceneJob.lastFailed = undefined;
      }
      // S6l §5：poke / gift 的情景说明并入 scene_notes。
      if (eventNote !== undefined) {
        sceneNotes = sceneNotes === undefined ? eventNote : `${sceneNotes}。${eventNote}`;
      }
      // S6c-fix1 §1：busy 兜底句用本轮 seq 分配器（在下方 LLM 流开始前发出），不再硬编码 0。
      let sceneBusyBeat: Beat | null = null;
      if (!isNudge && input.type === "text_input" && inputKind === "text") {
        const detected = detectSceneRequest(input.text, session.pack.sceneTriggerPattern);
        if (detected.hit) {
          // S6c-fix1 §6：缺扩写端口时准入直接拒绝（不用非空断言），并打日志。
          const writer = session.sceneWriter;
          const depsMissing = writer === undefined;
          const admission = admitSceneJob(session.sceneJob, clock());
          if (depsMissing) logTurn("scene_missing_writer");
          if (!admission.ok || depsMissing) {
            const reason = admission.ok ? "busy" : admission.reason;
            // S6c-fix1 §1：准入被拒 → scene_notes 说「换不了（原因）」，与兜底句不矛盾。
            const reasonText = SCENE_REJECT_NOTE[reason];
            sceneNotes = sceneNotes === undefined ? `对方想换背景，但现在换不了（${reasonText}）` : `${sceneNotes}。对方想换背景，但现在换不了（${reasonText}）`;
            sceneBusyBeat = {
              seq: 0,
              say: session.pack.fallback.scene_busy,
              emotion: "guarded",
              accent: null,
              hands: session.scene.hands,
              action: null,
              camera: null,
              fx: null,
              media: null,
              story: null,
            };
            session.send?.(buildEnvelope(session, turnId, "scene_status", { jobId: "", status: "busy" }));
            logTurn("scene_busy", { reason });
          } else {
            // S6c-fix1 §1：只有准入通过后才写「正在换」。
            sceneNotes = sceneNotes === undefined ? "对方想换个背景，你这边正在换" : `${sceneNotes}。对方想换个背景，你这边正在换`;
            // 发起场景任务（后台，不阻塞本轮）。
            const jobId = randomUUID();
            session.sceneJob = sceneJobReducer(session.sceneJob, { type: "request", jobId, at: clock() });
            // S6c-fix1 §7：参考图 = 当前正在显示的背景（上一次换成功的生成图，否则角色包默认背景）。
            // 生成图 URL 是 `{ desktop, mobile }`，角色包默认背景是 `{ portrait, landscape }`。
            // S6l-fix2 §5：读持久的 currentBackground（不再被一次性提示清空）。
            const current = session.sceneJob.currentBackground;
            const currentBg = current
              ? { desktop: current.urls.desktop, mobile: current.urls.mobile }
              : { desktop: session.pack.stage.background.landscape, mobile: session.pack.stage.background.portrait };
            const referencePaths = session.sceneReferencePaths ?? {
              desktop: resolveReferencePath(currentBg.desktop, referenceDirs),
              mobile: resolveReferencePath(currentBg.mobile, referenceDirs),
            };
            // S6c-fix1 §7：currentScene 传当前背景的描述（上次成功的 label，否则角色包默认场景描述），不是节点 id。
            // S6l-fix2 §5：同样读持久的 currentBackground。
            const currentScene = current?.label ?? session.pack.nodes[session.scene.node].label;
            const sceneDeps: SceneRunnerDeps = {
              writer,
              image: session.sceneImageGen as SceneRunnerDeps["image"],
              referencePaths,
              nodeLabel: session.pack.nodes[session.scene.node].label,
              currentScene,
              emit: (event, payload) => {
                session.sceneJob = sceneJobReducer(session.sceneJob, event);
                const statusPayload: SceneStatusPayload = {
                  jobId: payload.jobId,
                  status: payload.status as SceneStatusPayload["status"],
                  label: payload.label,
                  urls: payload.urls,
                  // S6c-fix1 §2：failed / rejected 带 category，兜底由剧情层承担。
                  category:
                    payload.status === "rejected"
                      ? "scene_rejected"
                      : payload.status === "failed"
                        ? "scene_failed"
                        : undefined,
                };
                session.send?.(buildEnvelope(session, turnId, "scene_status", statusPayload));
              },
              log: (event, detail) => logFor(session, turnId, event, detail),
              now: clock,
            };
            void runSceneJob(session.pack, input.text, jobId, sceneDeps, session.sceneController.signal).then((outcome) => {
              if (outcome.kind === "ready") {
                // ready 后：下一轮 scene_notes 加「背景已经换成 {label}」（一次性）；并持久记录当前背景。
                session.sceneJob = {
                  ...session.sceneJob,
                  pendingReadyNote: `背景已经换成 ${outcome.label}`,
                  currentBackground: { label: outcome.label, urls: outcome.urls },
                };
              } else {
                // failed / rejected：下一轮 scene_notes 提一句「刚才背景没换成」。
                session.sceneJob = { ...session.sceneJob, lastFailed: true };
                // S6l-fix1 §0：换背景失败 / 被拒写进错误统计（不含 Key、不含完整提示词）。
                // §2：失败带分类（timeout / session_aborted / other_image_failed / error），不再一律 "aborted"。
                if (outcome.kind === "failed") {
                  logTurn("scene_failed", { category: outcome.category, error: outcome.error });
                } else {
                  logTurn("scene_rejected", { note: outcome.note });
                }
              }
            }).catch(() => undefined);
          }
        }
      }

      firstTokenTimer = setTimeout(() => {
        llmTimedOut = true;
        llmAbort.abort();
      }, firstTokenTimeoutMs);

      // S6c-fix1 §1：busy 兜底句占用本轮下一个 seq（LLM 的 beat 顺延），不再硬编码 0，
      // 避免客户端按 seq 去重时把 LLM 的真实第一句丢掉。
      if (sceneBusyBeat !== null) {
        const seqBusyBeat = { ...sceneBusyBeat, seq: nextSeq };
        nextSeq += 1;
        if (!emit("beat", { beat: seqBusyBeat })) return;
        logTurn("beat_sent", { seq: seqBusyBeat.seq, silent: seqBusyBeat.say === "" });
        if (seqBusyBeat.say !== "") says.push(seqBusyBeat.say);
      }

      try {
        for await (const raw of session.ports.llm.streamBeats(
          { history: session.history, scene: session.scene, userText, pack: session.pack, nudge: isNudge, sceneNotes, kind: inputKind },
          llmSignal,
        )) {
          // 收到第一个 token 即撤销超时；后续不确定性交给现有取消语义。
          if (firstTokenTimer !== null) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }
          if (signal.aborted || llmTimedOut) break;

          const parsed = parseLlmBeatLenient(raw);
          if (parsed.warnings.length > 0) logTurn("llm_beat_warning", { warnings: parsed.warnings });

          // §1：只在本轮第一个 beat 注入保底推进目标；推进 / 用过后即清空。
          const beatCtx: DirectorContext =
            forcedNode !== null && !firstBeatSeen ? { ...directorCtx, forcedAdvanceTo: forcedNode } : { ...directorCtx, forcedAdvanceTo: undefined };
          const directed = direct(parsed.llmBeat, beatCtx);
          directorCtx = directed.ctx;
          session.scene = directorCtx.scene;
          session.recentActions = directorCtx.recentActions;
          session.recentAccents = directorCtx.recentAccents;

          // §1：保底推进真正落地（LLM 未提出，由导演层强制）时记一条 story_forced。
          if (
            forcedNode !== null &&
            parsed.llmBeat.advance === null &&
            directed.beats.some(({ beat }) => beat.story?.advance === forcedNode)
          ) {
            logTurn("story_forced", { from: nodeBefore, to: forcedNode });
          }

          const suggested = parsed.llmBeat.suggest;
          const proposedAdvance = parsed.llmBeat.advance;
          logTurn("director_decision", {
            suggest: suggested,
            suggestAccepted: suggested !== null && directed.beats.some(({ beat }) => beat.action === suggested),
            advance: proposedAdvance,
            advanceAccepted:
              proposedAdvance !== null && directed.beats.some(({ beat }) => beat.story?.advance === proposedAdvance),
          });

          for (const { beat, ttsText } of directed.beats) {
            const seqBeat = { ...beat, seq: nextSeq };
            nextSeq += 1;

            // D27：剧情层媒体事件 id = <sessionId>:<turn>:<seq>，随 beat 一起下发。
            const beatMedia = seqBeat.media;
            const storyEventId = beatMedia !== null ? `${session.id}:${turnId}:${seqBeat.seq}` : null;
            const outBeat: Beat =
              storyEventId !== null && beatMedia !== null ? { ...seqBeat, media: { ...beatMedia, storyEventId } } : seqBeat;

            if (!firstBeatSeen) {
              firstBeatSeen = true;
              logTurn("llm_first_beat", { seq: outBeat.seq });
            }
            if (!emit("beat", { beat: outBeat })) return;
            if (beatMedia !== null && storyEventId !== null) {
              scheduleMediaDelivery(session, turnId, beatMedia, storyEventId);
            }
            beatsSent += 1;
            logTurn("beat_sent", { seq: outBeat.seq, silent: outBeat.say === "" });

            // ws_drop：第 2 个 beat 发出后由传输层关闭连接，本轮不再产出。
            if (beatsSent === WS_DROP_AFTER_BEAT && session.faults.includes("ws_drop")) {
              logTurn("ws_drop", { afterBeat: beatsSent });
              deps.dropConnection?.(session.id);
              closed = true;
              return;
            }

            if (outBeat.say !== "") {
              says.push(outBeat.say);
              const beatSeq = outBeat.seq;
              const ttsTextForBeat = ttsText;
              const emotionForBeat = outBeat.emotion;
              ttsChain = ttsChain.then(async () => {
                // D49 / S6n §3：上一句报 voice_unavailable 后，本轮不再发起新的 TTS。
                if (voiceFailed) return;
                // S6b-fix1 §1/§2：音色与 Mock 目录都按会话角色包决定。
                const result = await synthesizeWithRetry(
                  session.ports.tts,
                  ttsTextForBeat,
                  { emotion: emotionForBeat, beatSeq, voiceId: session.voiceId, characterId: session.pack.id },
                  signal,
                );
                if (!result.ok) {
                  if (signal.aborted || isAbortError(result.error)) return;
                  // D49 / S6n §3：Fish 4xx（音色 / 权限相关）→ voice_unavailable（会话级）。
                  // 不省略 reference_id 重试（已在 synthesizeWithRetry 里停止重试），不静默回落默认音色。
                  if (isFishApiError(result.error) && result.error.code === "fish_voice") {
                    voiceFailed = true;
                    logTurn("voice_unavailable");
                    emitFinal("error", {
                      code: "voice_unavailable",
                      message: "这个 Fish Key 用不了当前音色",
                      retryable: false,
                      scope: "session",
                    });
                    return;
                  }
                  // TTS 降级（D20）：这一句无声，本轮继续，只附一条不打断体验的提示。
                  if (!ttsDegraded) {
                    ttsDegraded = true;
                    logTurn("fallback_used", { category: "tts" });
                  }
                  emit("error", {
                    code: "tts_degraded",
                    message: `第 ${beatSeq} 句语音合成失败，已降级为无声 beat`,
                    retryable: false,
                  });
                  return;
                }
                if (!emit("tts_audio", { beatSeq, mime: result.value.mime, dataBase64: result.value.data.toString("base64") })) return;
                if (!ttsFirstLogged) {
                  ttsFirstLogged = true;
                  logTurn("tts_first_audio", { seq: beatSeq });
                }
                logTurn("tts_done", { seq: beatSeq });
              });
            }
          }
        }
      } finally {
        if (firstTokenTimer !== null) {
          clearTimeout(firstTokenTimer);
          firstTokenTimer = null;
        }
      }

      await ttsChain;
      if (signal.aborted) {
        logTurn("turn_aborted");
        return;
      }

      closed = true;
      // §1：本轮推进了（LLM 自己走或保底强制）→ 计数清零；否则写入基线计数。
      session.stalledUserTurns = session.scene.node !== nodeBefore ? 0 : forced.nextStalled;
      // S6l-fix2 §7：记录用户条目的来源（user / nudge / poke / gift），供 userTurns 与刷新恢复过滤。
      const historySource: HistorySource = isNudge ? "nudge" : inputKind === "poke" || inputKind === "gift" ? inputKind : "user";
      session.history.push(
        { role: "user", text: userText, source: historySource },
        { role: "assistant", text: says.join("\n") },
      );
      session.scene = { ...session.scene, turnCount: session.scene.turnCount + 1 };
      if (!emitFinal("state_snapshot", { snapshot: session.scene })) return;
      if (!emitFinal("turn_end", { reason: "done" })) return;
      logTurn("turn_end", { reason: "done" });
    } catch (error) {
      closed = true;
      // 等 TTS 链收尾，确保不会在 turn_end 之后又发出 tts_audio（链内发送已被 closed 拦截）。
      await ttsChain.catch(() => {});
      if (signal.aborted) {
        logTurn("turn_aborted");
        return;
      }
      if (llmTimedOut) {
        // LLM 首 token 超时（D10）：兜底台词 → error{llm_timeout} → turn_end{error}。
        logTurn("fallback_used", { category: "llm_timeout" });
        if (!emitFinal("beat", { beat: fallbackBeat(session, "llm_timeout") })) return;
        if (!emitFinal("error", { code: "llm_timeout", message: "LLM 首 token 超时，已使用兜底台词", retryable: true })) return;
        if (!emitFinal("turn_end", { reason: "error" })) return;
        logTurn("turn_end", { reason: "error" });
        return;
      }
      if (isAbortError(error)) {
        logTurn("turn_aborted");
        return;
      }
      // S6n §4：适配器报错可能回显请求头 / URL 参数，写日志与下发前统一脱敏（Key 绝不外泄）。
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      // S6b §2：其余未预期错误 —— 服务端照常记录错误日志；客户端改播 pack 的 turn_failed 兜底台词，
      // 不再显示原始 error code/message（原始信息只在 ?debug=1 面板显示）。retryable 语义不变。
      logTurn("turn_failed", { message });
      logTurn("fallback_used", { category: "turn_failed" });
      if (!emitFinal("beat", { beat: fallbackBeat(session, "turn_failed") })) return;
      if (!emitFinal("error", { code: "turn_failed", message, retryable: true })) return;
      if (!emitFinal("turn_end", { reason: "error" })) return;
      logTurn("turn_end", { reason: "error" });
    }
  }

  function handleHello(send: SendFn, message: Extract<ClientMessage, { type: "hello" }>): void {
    // S6b-fix1 §3：同一连接上建立新会话时，解绑该连接上的其它会话——
    // 中止轮次与后台媒体任务、断开 send（会话本身留给空闲回收）。
    // 否则旧会话的后台媒体任务完成后会把 media_ready 发进新频道。
    // S6c §5：同时中止换背景任务（切频道 → 取消并丢弃该会话的任务）。
    for (const other of sessions.values()) {
      if (other.send !== null && other.send === send) {
        other.controller?.abort();
        other.controller = null;
        other.mediaController.abort();
        other.sceneController.abort();
        other.send = null;
        logFor(other, other.lastTurnId, "session_unbound", { reason: "new_hello" });
      }
    }

    const resumedId = message.payload.resumeSessionId;
    // freeze-fix2 §2：恢复会话时只有 faults 集合（与顺序、重复无关）与旧会话相等才恢复；
    // 否则按新会话处理，让本次请求的 faults 生效（旧会话的 faults 不混入）。
    const requestedFaults = parseFaults(message.payload.faults ?? deps.defaultFaults);
    const candidate = resumedId ? sessions.get(resumedId) : undefined;
    const existing = candidate && shouldResume(candidate.faults, requestedFaults) ? candidate : undefined;
    if (candidate && !existing) {
      logFor(candidate, candidate.lastTurnId, "resume_skipped", { reason: "faults_changed" });
    }
    let session: Session;
    if (existing) {
      // §2：恢复会话沿用该会话原来的模式与 Key，不重新读 hello 里的 mode / keys。
      session = existing;
      logFor(session, session.lastTurnId, "session_resumed");
    } else {
      // D43：缺省角色 = 目录里第一个（忧奈）；未知 id → error{unknown_character} 并关闭会话，不回退。
      const characterId = message.payload.characterId ?? (deps.packs ? defaultCharacterId(deps.packs) : "yuna");
      const pack = deps.packs?.get(characterId);
      if (!pack) {
        deps.log({ ts: clock(), sessionId: message.sessionId, turnId: message.turnId, event: "unknown_character", detail: { characterId } });
        send({
          v: 1,
          sessionId: message.sessionId,
          turnId: message.turnId,
          seq: 0,
          ts: clock(),
          type: "error",
          payload: { code: "unknown_character", message: `未知角色：${characterId}`, retryable: false, scope: "session" },
        });
        deps.closeConnection?.(send);
        return;
      }

      // D49 / S6n §2：解析模式与 Key（纯函数）。显式 real 但缺 LLM / 语音 Key → real_unavailable，不建会话。
      const plan = planFor(message.payload.mode ?? "auto", message.payload.keys);
      logFor2(message.sessionId, message.turnId, "hello_provision", {
        mode: plan.ok ? plan.mode : "real",
        byok: {
          llm: plan.ok ? plan.capabilities.llm === "user" : false,
          voice: plan.ok ? plan.capabilities.voice === "user" : false,
          image: plan.ok ? plan.capabilities.image === "user" : false,
        },
      });
      if (!plan.ok) {
        send({
          v: 1,
          sessionId: message.sessionId,
          turnId: message.turnId,
          seq: 0,
          ts: clock(),
          type: "error",
          payload: {
            code: "real_unavailable",
            message: missingMessage(plan.missing),
            retryable: false,
            scope: "session",
          },
        });
        return;
      }

      const faults = requestedFaults;
      // §1：mock 复用全局共享的无状态适配器；real 且访问者自带 Key → 为该会话单独构建。
      const built = resolveBuilt(plan);
      const ports = faults.length === 0 ? built.ports : {
        stt: withFaults(built.ports.stt, "stt", faults),
        llm: withFaults(built.ports.llm, "llm", faults),
        tts: withFaults(built.ports.tts, "tts", faults),
      };
      session = {
        id: randomUUID(),
        send: null,
        pack,
        history: [],
        scene: createInitialScene(),
        recentActions: [],
        recentAccents: [],
        pokeCount: 0,
        stalledUserTurns: 0,
        startedAt: clock(),
        lastPokeAt: null,
        lastGiftAt: null,
        lastTurnId: 0,
        turnsUsed: 0,
        controller: null,
        lastActiveAt: clock(),
        outSeq: 0,
        ports,
        faults,
        turnStartedAt: null,
        mediaSent: new Set(),
        mediaController: new AbortController(),
        // §3：访问者覆盖的音色优先于角色包音色。
        voiceId: plan.voiceIdUser !== "" ? plan.voiceIdUser : resolveVoiceId(pack),
        sceneJob: initialSceneJobState(),
        sceneController: new AbortController(),
        sceneWriter: built.sceneWriter,
        sceneImageGen: built.sceneImageGen,
        sceneReferencePaths: deps.sceneReferencePaths,
        mode: plan.mode,
        capabilities: plan.capabilities,
        voiceIdUser: plan.voiceIdUser,
        media: built.media,
      };
      sessions.set(session.id, session);
      logFor(session, 0, "session_created", { faults, characterId: pack.id, mode: plan.mode });
    }

    // 重连/重绑连接：旧连接上仍在跑的一轮没有意义，直接中止。
    session.controller?.abort();
    session.controller = null;
    // S6c-fix1 §4：恢复（或重绑）会话时重建换背景任务的 controller——
    // 解绑时会 abort 掉它，若不重建，之后每次换背景都会立即失败并扣次数。
    if (session.sceneController.signal.aborted) session.sceneController = new AbortController();
    session.send = send;
    session.lastActiveAt = clock();

    send(buildEnvelope(session, session.lastTurnId, "session", {
      snapshot: session.scene,
      ...resumePayload(session),
      mode: session.mode,
      capabilities: session.capabilities,
      // §5.1：会话创建时刻（恢复会话沿用原值）。
      startedAt: session.startedAt,
    }));
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

  /**
   * §6：客户端上报第一个 beat 的音频开始播放。计算并记录 first_audio_ms
   * （客户端 roundtrip 时间，D17 在客户端测量），并带上服务端侧的本轮耗时对照。
   */
  function handlePlaybackStarted(session: Session, message: Extract<ClientMessage, { type: "playback_started" }>): void {
    session.lastActiveAt = clock();
    const started = session.turnStartedAt;
    const serverMs = started !== null && started.turnId === message.turnId ? clock() - started.at : null;
    logFor(session, message.turnId, "playback_started", {
      seq: message.payload.seq,
      clientMs: message.payload.clientMs,
      first_audio_ms: message.payload.clientMs,
      server_ms: serverMs,
    });
  }

  async function handleTurnInput(session: Session, input: TurnInput): Promise<void> {
    session.lastActiveAt = clock();

    if (!isTurnIdAcceptable(session.lastTurnId, input.turnId)) {
      logFor(session, input.turnId, "stale_turn", { incoming: input.turnId, last: session.lastTurnId });
      session.send?.(
        buildEnvelope(session, input.turnId, "error", {
          code: "stale_turn",
          message: `turnId ${input.turnId} 必须大于 ${session.lastTurnId}`,
          retryable: false,
        }),
      );
      return;
    }

    // Q12 限额：超出时只回 error，不创建 controller、不调用任何 Provider。
    // D32：主动开口轮不计入会话限额与会话轮数。
    if (input.type !== "nudge") {
      const at = clock();
      const day = localDayKey(at);
      if (daily.day !== day) {
        daily.day = day;
        daily.count = 0;
      }
      const scope = session.turnsUsed >= sessionTurnLimit ? "session" : daily.count >= dailyTurnLimit ? "daily" : null;
      if (scope !== null) {
        const limit = scope === "session" ? sessionTurnLimit : dailyTurnLimit;
        const used = scope === "session" ? session.turnsUsed : daily.count;
        logFor(session, input.turnId, "quota_exceeded", { scope, used, limit });
        session.send?.(
          buildEnvelope(session, input.turnId, "error", {
            code: "quota_exceeded",
            message: scope === "session" ? `本次会话最多 ${limit} 轮` : `今天的体验额度已用完（${limit} 轮）`,
            retryable: false,
            // S6b-fix3 §1：额度上限与具体轮次无关，按会话级处理（跳过客户端 D3 过滤）。
            scope: "session",
          }),
        );
        return;
      }
      session.turnsUsed += 1;
      daily.count += 1;
    }

    if (session.controller) {
      const supersededTurnId = session.lastTurnId;
      session.controller.abort();
      logFor(session, supersededTurnId, "turn_aborted", { reason: "superseded" });
    }

    session.lastTurnId = input.turnId;
    const controller = new AbortController();
    session.controller = controller;
    try {
      await runTurn(session, input, controller.signal);
    } finally {
      if (session.controller === controller) session.controller = null;
    }
  }

  async function handleMessage(send: SendFn, message: ClientMessage): Promise<void> {
    if (message.type === "hello") {
      handleHello(send, message);
      return;
    }

    // 心跳：pong 由传输层（index.ts）直接回复；会话层不产生下行消息。
    if (message.type === "ping") return;

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
        payload: { code: "unknown_session", message: "会话不存在，请重新 hello", retryable: true, scope: "session" },
      });
      return;
    }
    session.send ??= send;

    if (message.type === "playback_started") {
      handlePlaybackStarted(session, message);
      return;
    }
    if (message.type === "interrupt") {
      handleInterrupt(session, message);
      return;
    }
    // D32：主动开口按一次新输入处理（不计入限额，见 handleTurnInput）。
    if (message.type === "nudge") {
      await handleTurnInput(session, { type: "nudge", turnId: message.turnId });
      return;
    }
    if (message.type === "audio_input") {
      await handleTurnInput(session, {
        type: "audio_input",
        turnId: message.turnId,
        mime: message.payload.mime,
        dataBase64: message.payload.dataBase64,
      });
      return;
    }
    // S6l-fix2 §6：服务端限量 poke / gift——冷却内重复请求直接忽略（不起新轮、不扣轮数、记日志）。
    // S6m §0：但客户端发出 poke / gift 时已 beginTurn 进入 thinking，等不到 turn_end 会一直卡着；
    // 因此被限流时仍回一条**无 beat**的 turn_end{reason:"throttled"}，客户端按现有规则回 idle。
    const kind = message.payload.kind;
    if (kind === "poke" || kind === "gift") {
      const lastAt = kind === "poke" ? session.lastPokeAt : session.lastGiftAt;
      if (!throttleEvent(lastAt, clock(), kind)) {
        logFor(session, message.turnId, "input_throttled", { kind });
        session.send?.(buildEnvelope(session, message.turnId, "turn_end", { reason: "throttled" }));
        return;
      }
      if (kind === "poke") session.lastPokeAt = clock();
      else session.lastGiftAt = clock();
    }
    await handleTurnInput(session, { type: "text_input", turnId: message.turnId, text: message.payload.text, kind });
  }

  const sweepTimer = setInterval(() => {
    const cutoff = clock() - idleTimeoutMs;
    for (const [id, session] of sessions) {
      if (session.lastActiveAt > cutoff) continue;
      session.controller?.abort();
      // S6c-fix1 §4：会话过期清理也要中止进行中的换背景任务（不白白付费）。
      session.sceneController.abort();
      sessions.delete(id);
      logFor(session, session.lastTurnId, "session_expired");
    }
  }, deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  return {
    handleMessage,
    dispose() {
      clearInterval(sweepTimer);
      for (const session of sessions.values()) {
        session.controller?.abort();
        session.mediaController.abort();
        // S6c-fix1 §4：dispose 也要中止进行中的换背景任务。
        session.sceneController.abort();
      }
      sessions.clear();
    },
  };
}
