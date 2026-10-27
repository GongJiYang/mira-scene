import { z } from "zod";

export const emotionSchema = z.enum(["neutral", "calm", "guarded", "sad", "warm", "surprised"]);
/** D28：手部图层（原 pose）。 */
export const handsSchema = z.enum(["cup", "polaroid", "camera", "phone"]);
/**
 * D29 / D40：封闭动作表。S6b §1 改成通用槽位（每个角色在提示词里解释含义）：
 * drink（喝一口）/ glance（瞟一眼）/ phone（看手机）/ show_item（把东西给对方看）。
 */
export const actionSchema = z.enum(["drink", "glance", "phone", "show_item"]);
export const cameraSchema = z.enum(["wide", "close_up"]);
/**
 * S6g-A §2：新增 `stream_dim`（舞台压暗）/ `hearts`（爱心漂浮，由 `ParamHeart` 驱动）。
 * 旧值（`rain_heavy` / `rain_stop` / `lights_dim` / `warm_glow`）保留不删，避免牵连太广（任务 §1）。
 */
export const fxSchema = z.enum(["rain_heavy", "rain_stop", "lights_dim", "warm_glow", "stream_dim", "hearts"]);
export const storyNodeSchema = z.enum(["arrive", "probe", "reveal", "ending"]);
export const mediaTypeSchema = z.enum(["photo", "video"]);

export type Emotion = z.infer<typeof emotionSchema>;
export type Hands = z.infer<typeof handsSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Camera = z.infer<typeof cameraSchema>;
export type Fx = z.infer<typeof fxSchema>;
export type StoryNode = z.infer<typeof storyNodeSchema>;
export type MediaType = z.infer<typeof mediaTypeSchema>;
