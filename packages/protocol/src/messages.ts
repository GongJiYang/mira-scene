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
});

export const textInputPayloadSchema = z.object({
  text: z.string().min(1).max(500),
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

export const sessionPayloadSchema = z.object({
  snapshot: sceneStateSchema,
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
  reason: z.enum(["done", "interrupted", "error"]),
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

export type HelloPayload = z.infer<typeof helloPayloadSchema>;
export type TextInputPayload = z.infer<typeof textInputPayloadSchema>;
export type AudioInputPayload = z.infer<typeof audioInputPayloadSchema>;
export type InterruptPayload = z.infer<typeof interruptPayloadSchema>;
export type PlaybackStartedPayload = z.infer<typeof playbackStartedPayloadSchema>;
export type SessionPayload = z.infer<typeof sessionPayloadSchema>;
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
