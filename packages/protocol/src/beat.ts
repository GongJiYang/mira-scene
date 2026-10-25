import { z } from "zod";
import {
  actionSchema,
  cameraSchema,
  emotionSchema,
  fxSchema,
  mediaTypeSchema,
  poseSchema,
  storyNodeSchema,
} from "./enums";

export const mediaSchema = z.object({
  type: mediaTypeSchema,
  id: z.string(),
});

export const storyStepSchema = z.object({
  advance: storyNodeSchema,
});

export const beatSchema = z.object({
  seq: z.number().int().nonnegative(),
  say: z.string(),
  emotion: emotionSchema,
  pose: poseSchema,
  action: actionSchema.nullable(),
  camera: cameraSchema.nullable(),
  fx: fxSchema.nullable(),
  media: mediaSchema.nullable(),
  story: storyStepSchema.nullable(),
});

export type Media = z.infer<typeof mediaSchema>;
export type StoryStep = z.infer<typeof storyStepSchema>;
export type Beat = z.infer<typeof beatSchema>;
