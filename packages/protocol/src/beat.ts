import { z } from "zod";
import {
  actionSchema,
  cameraSchema,
  emotionSchema,
  fxSchema,
  handsSchema,
  mediaTypeSchema,
  storyNodeSchema,
} from "./enums";

export const mediaSchema = z.object({
  type: mediaTypeSchema,
  id: z.string(),
  /** 剧情层媒体（D27）就绪后可带可访问地址；beat.media 允许省略。 */
  url: z.string().optional(),
});

export const storyStepSchema = z.object({
  advance: storyNodeSchema,
});

export const beatSchema = z.object({
  seq: z.number().int().nonnegative(),
  say: z.string(),
  emotion: emotionSchema,
  hands: handsSchema,
  action: actionSchema.nullable(),
  camera: cameraSchema.nullable(),
  fx: fxSchema.nullable(),
  media: mediaSchema.nullable(),
  story: storyStepSchema.nullable(),
});

/**
 * 契约 ①：LLM 原始输出。
 * LLM 只能给台词、情绪、可选建议动作、可选剧情推进；视觉其余字段由导演层决定（D29）。
 * 本批只定义 schema，暂不接入流水线。
 */
export const llmBeatSchema = z.object({
  say: z.string(),
  emotion: emotionSchema,
  suggest: actionSchema.nullish(),
  advance: storyNodeSchema.nullish(),
});

export type Media = z.infer<typeof mediaSchema>;
export type StoryStep = z.infer<typeof storyStepSchema>;
export type Beat = z.infer<typeof beatSchema>;
export type LlmBeat = z.infer<typeof llmBeatSchema>;
