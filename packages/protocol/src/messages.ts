import { z } from "zod";
import { beatSchema } from "./beat";
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
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...envelopeFields, type: z.literal("hello"), payload: helloPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("text_input"), payload: textInputPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("audio_input"), payload: audioInputPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("interrupt"), payload: interruptPayloadSchema }),
]);

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...envelopeFields, type: z.literal("session"), payload: sessionPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("transcript"), payload: transcriptPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("beat"), payload: beatPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("tts_audio"), payload: ttsAudioPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("turn_end"), payload: turnEndPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("state_snapshot"), payload: stateSnapshotPayloadSchema }),
  z.object({ ...envelopeFields, type: z.literal("error"), payload: errorPayloadSchema }),
]);

export type HelloPayload = z.infer<typeof helloPayloadSchema>;
export type TextInputPayload = z.infer<typeof textInputPayloadSchema>;
export type AudioInputPayload = z.infer<typeof audioInputPayloadSchema>;
export type InterruptPayload = z.infer<typeof interruptPayloadSchema>;
export type SessionPayload = z.infer<typeof sessionPayloadSchema>;
export type TranscriptPayload = z.infer<typeof transcriptPayloadSchema>;
export type BeatPayload = z.infer<typeof beatPayloadSchema>;
export type TtsAudioPayload = z.infer<typeof ttsAudioPayloadSchema>;
export type TurnEndPayload = z.infer<typeof turnEndPayloadSchema>;
export type StateSnapshotPayload = z.infer<typeof stateSnapshotPayloadSchema>;
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function parseClientMessage(input: unknown) {
  return clientMessageSchema.safeParse(input);
}

export function parseServerMessage(input: unknown) {
  return serverMessageSchema.safeParse(input);
}
