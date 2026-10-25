import { z } from "zod";
import { cameraSchema, emotionSchema, fxSchema, poseSchema, storyNodeSchema } from "./enums";

export const trustSchema = z.number().int().min(0).max(3);

export const sceneStateSchema = z.object({
  node: storyNodeSchema,
  trust: trustSchema,
  flags: z.array(z.string()),
  emotion: emotionSchema,
  pose: poseSchema,
  camera: cameraSchema.nullable(),
  fx: fxSchema.nullable(),
  turnCount: z.number().int().nonnegative(),
});

export type SceneState = z.infer<typeof sceneStateSchema>;
