import { z } from "zod";
import { beatSchema, mediaSchema } from "./beat";
import { sceneStateSchema } from "./scene";

const nonNegativeInt = z.number().int().nonnegative();

const envelopeFields = {
  v: z.literal(1),
  sessionId: z.string(),
  turnId: nonNegativeInt,
  seq: nonNegativeInt,
  ts: z.number(),
};

/**
 * D49 / S6n §2：访问者自带的 Key（BYOK）。每类都可选：
 * - `deepseek`：聊天（LLM）；
 * - `fish`：语音（STT + TTS），可覆盖音色；
 * - `image`：生图（OpenAI 兼容端点）。
 * 这些值只在访问者自己的会话内存中使用，服务端不保存、不打印、不回传。
 */
export const helloKeysSchema = z.object({
  deepseek: z.object({ apiKey: z.string() }).optional(),
  fish: z.object({ apiKey: z.string(), voiceId: z.string().optional() }).optional(),
  image: z.object({ apiKey: z.string(), baseUrl: z.string(), model: z.string().optional() }).optional(),
});

export const helloPayloadSchema = z.object({
  resumeSessionId: z.string().optional(),
  /**
   * S6b §1：客户端选定的角色包 id。缺省 → `rin`（兼容旧客户端与既有测试）；
   * 不存在的 id → 服务端返回 `error{code:"unknown_character"}` 并关闭会话，不回退。
   */
  characterId: z.string().optional(),
  /**
   * S5 故障注入（Q11）：客户端把 URL 的 `?fail=` 解析后随 hello 下发，
   * 服务端按会话生效；缺省时使用环境变量 FAULTS 的全局默认值。
   */
  faults: z.array(z.string()).optional(),
  /**
   * D49 / S6n §2：访问者请求的模式。缺省 `auto`——
   * LLM 与语音都有可用 Key（访问者或服务端）则 real，否则 mock。
   * 恢复会话（resumeSessionId）时忽略本字段，沿用会话原模式与 Key。
   */
  mode: z.enum(["mock", "real", "auto"]).optional(),
  /** D49 / S6n §2：访问者自带的 Key（缺省则全部用服务端 `.env`）。 */
  keys: helloKeysSchema.optional(),
});

export const textInputPayloadSchema = z.object({
  text: z.string().min(1).max(500),
  /**
   * S6l §5：输入类型。`text`（缺省）= 普通文字；`poke` = 戳一下；`gift` = 送礼物。
   * poke / gift 时 `text` 仍必填（用于占位），服务端把它们转成给 LLM 的情景说明，不当作用户台词。
   */
  kind: z.enum(["text", "poke", "gift"]).optional(),
});

export const audioInputPayloadSchema = z.object({
  mime: z.string(),
  dataBase64: z.string(),
});

export const interruptPayloadSchema = z.object({
  interruptedTurnId: nonNegativeInt,
});

/**
 * §6 计时：第一个 beat 的音频开始播放时，客户端上报一次。
 * `clientMs` 是客户端从本轮开始到开始播放的毫秒数（D17 在客户端测量）。
 */
export const playbackStartedPayloadSchema = z.object({
  turnId: nonNegativeInt,
  seq: nonNegativeInt,
  clientMs: z.number().nonnegative(),
});

/**
 * S6l-fix1 §1：恢复会话时随 `session` 下发的背景与对话记录。
 * - `background`：当前正在显示的生成背景（`sceneJob.currentBackground`）；没换过背景为 null。
 * - `transcript`：最近最多 40 条对话（user / assistant），用于刷新后恢复用户弹幕。
 *   S6l-fix2 §7：只含 `source === "user"` 的用户条目（nudge / poke / gift 占位不进弹幕区）。
 * 新会话为 `background: null, transcript: []`；对旧客户端是新增可选字段，不破坏解析。
 */
export const sessionTranscriptEntrySchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});

/**
 * D49 / S6n §2：每一类能力的来源。只说明来源，**不含任何 Key**。
 * - `"user"`：访问者在设置面板里填的 Key；
 * - `"server"`：服务端 `.env` 里配置的 Key；
 * - `"none"`：两边都没有。
 */
export const capabilitySourceSchema = z.enum(["user", "server", "none"]);

export const sessionCapabilitiesSchema = z.object({
  llm: capabilitySourceSchema,
  voice: capabilitySourceSchema,
  image: capabilitySourceSchema,
});

export const sessionPayloadSchema = z.object({
  snapshot: sceneStateSchema,
  background: z
    .object({ label: z.string(), urls: z.object({ desktop: z.string(), mobile: z.string() }) })
    .nullish(),
  transcript: z.array(sessionTranscriptEntrySchema).optional(),
  /** D49 / S6n §2：本会话实际生效的模式（`mock` 或 `real`）。 */
  mode: z.enum(["mock", "real"]).optional(),
  /** D49 / S6n §2：各类能力的来源（只说明来源，不含 Key）。 */
  capabilities: sessionCapabilitiesSchema.optional(),
  /**
   * §5.1：会话创建时刻（服务端 epoch ms）。客户端据此显示真实开播时长 `HH:MM:SS`；
   * 恢复会话沿用原值（从会话开始时刻继续）。
   */
  startedAt: z.number().optional(),
});

export const transcriptPayloadSchema = z.object({
  text: z.string(),
});

export const beatPayloadSchema = z.object({
  beat: beatSchema,
});

export const ttsAudioPayloadSchema = z.object({
  beatSeq: nonNegativeInt,
  mime: z.string(),
  dataBase64: z.string(),
});

export const turnEndPayloadSchema = z.object({
  /**
   * S6m §0：`throttled` —— 服务端对 poke / gift 限流时不下发 beat、不扣轮数，
   * 但必须回一条无 beat 的 turn_end，否则客户端会一直卡在 thinking。
   */
  reason: z.enum(["done", "interrupted", "error", "throttled"]),
});

export const stateSnapshotPayloadSchema = z.object({
  snapshot: sceneStateSchema,
});

export const errorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  /**
   * S6b-fix3 §1：错误范围。`"session"` 级（unknown_character / unknown_session /
   * quota_exceeded 等与具体轮次无关）跳过客户端 D3 的 turnId 过滤；`"turn"` 级
   * （llm_timeout / turn_failed / stale_turn / tts_degraded 等）回到过滤之后。
   * 缺省视为 `"turn"`（向后兼容）。
   */
  scope: z.enum(["session", "turn"]).optional(),
});

/** D27：剧情层媒体就绪事件，只与 storyEventId 绑定，不跟 turnId 作废。 */
export const mediaReadyPayloadSchema = z.object({
  storyEventId: z.string(),
  media: mediaSchema,
  status: z.enum(["ready", "fallback"]),
});

/**
 * D32：客户端主动开口（nudge）。turnId 由信封携带并递增，服务端按一次新输入处理；
 * 这一轮不计入 trust，也不计入会话限额。
 */
export const nudgePayloadSchema = z.object({});

/** 心跳：本批只定义 schema，收发逻辑在 G1-c。 */
export const pingPayloadSchema = z.object({});
export const pongPayloadSchema = z.object({});

/**
 * S6c §5：弹幕换背景的任务状态。
 * 由服务端在场景任务状态变化时下发；不绑定轮次（与 media_ready 同属剧情层旁路）。
 *
 * S6c-fix1 §2：失败的兜底不再发轮次 beat，改由剧情层承担——`failed / rejected` 载荷带
 * `category`（`scene_failed` / `scene_rejected`），客户端据此在空档播放本地预录兜底音频与字幕。
 */
export const sceneStatusPayloadSchema = z.object({
  jobId: z.string(),
  status: z.enum(["writing", "generating", "ready", "failed", "rejected", "busy"]),
  label: z.string().optional(),
  urls: z.object({ desktop: z.string(), mobile: z.string() }).optional(),
  category: z.enum(["scene_failed", "scene_rejected"]).optional(),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...envelopeFields, type: z.literal("hello"), payload: helloPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("text_input"), payload: textInputPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("audio_input"), payload: audioInputPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("interrupt"), payload: interruptPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("nudge"), payload: nudgePayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("playback_started"), payload: playbackStartedPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("ping"), payload: pingPayloadSchema }),
]);

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...envelopeFields, type: z.literal("session"), payload: sessionPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("transcript"), payload: transcriptPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("beat"), payload: beatPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("tts_audio"), payload: ttsAudioPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("turn_end"), payload: turnEndPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("state_snapshot"), payload: stateSnapshotPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("media_ready"), payload: mediaReadyPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("pong"), payload: pongPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("error"), payload: errorPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("scene_status"), payload: sceneStatusPayloadSchema }),
]);

export type HelloKeys = z.infer<typeof helloKeysSchema>;
export type HelloPayload = z.infer<typeof helloPayloadSchema>;
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;
export type SessionCapabilities = z.infer<typeof sessionCapabilitiesSchema>;
export type TextInputPayload = z.infer<typeof textInputPayloadSchema>;
export type AudioInputPayload = z.infer<typeof audioInputPayloadSchema>;
export type InterruptPayload = z.infer<typeof interruptPayloadSchema>;
export type PlaybackStartedPayload = z.infer<typeof playbackStartedPayloadSchema>;
export type SessionPayload = z.infer<typeof sessionPayloadSchema>;
export type SessionTranscriptEntry = z.infer<typeof sessionTranscriptEntrySchema>;
export type TranscriptPayload = z.infer<typeof transcriptPayloadSchema>;
export type BeatPayload = z.infer<typeof beatPayloadSchema>;
export type TtsAudioPayload = z.infer<typeof ttsAudioPayloadSchema>;
export type TurnEndPayload = z.infer<typeof turnEndPayloadSchema>;
export type StateSnapshotPayload = z.infer<typeof stateSnapshotPayloadSchema>;
export type MediaReadyPayload = z.infer<typeof mediaReadyPayloadSchema>;
export type NudgePayload = z.infer<typeof nudgePayloadSchema>;
export type PingPayload = z.infer<typeof pingPayloadSchema>;
export type PongPayload = z.infer<typeof pongPayloadSchema>;
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;
export type SceneStatusPayload = z.infer<typeof sceneStatusPayloadSchema>;

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function parseClientMessage(input: unknown) {
  return clientMessageSchema.safeParse(input);
}

export function parseServerMessage(input: unknown) {
  return serverMessageSchema.safeParse(input);
}
