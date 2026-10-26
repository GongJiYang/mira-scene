import { z } from "zod";
import { cameraSchema, emotionSchema, fxSchema, handsSchema, storyNodeSchema } from "./enums";

export const trustSchema = z.number().int().min(0).max(3);

export const sceneStateSchema = z.object({
  node: storyNodeSchema,
  trust: trustSchema,
  flags: z.array(z.string()),
  emotion: emotionSchema,
  hands: handsSchema,
  camera: cameraSchema.nullable(),
  fx: fxSchema.nullable(),
  turnCount: z.number().int().nonnegative(),
  /**
   * s3-fix §2：进入 reveal 时的轮次（只新增可选字段）。
   * 供 `advanceRule` 判定「进入 reveal 两轮之后」才允许 ending；缺省表示尚未进入 reveal。
   */
  revealTurn: z.number().int().nonnegative().optional(),
});

export type SceneState = z.infer<typeof sceneStateSchema>;
