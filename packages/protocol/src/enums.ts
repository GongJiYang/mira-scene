import { z } from "zod";

export const emotionSchema = z.enum(["neutral", "calm", "guarded", "sad", "warm", "surprised"]);
/** D28：手部图层（原 pose）。 */
export const handsSchema = z.enum(["cup", "polaroid", "camera", "phone"]);
/** D29：封闭动作表。 */
export const actionSchema = z.enum(["sip_coffee", "glance_window", "check_phone", "show_polaroid"]);
export const cameraSchema = z.enum(["wide", "close_up"]);
export const fxSchema = z.enum(["rain_heavy", "rain_stop", "lights_dim", "warm_glow"]);
export const storyNodeSchema = z.enum(["arrive", "probe", "reveal", "ending"]);
export const mediaTypeSchema = z.enum(["photo", "video"]);

export type Emotion = z.infer<typeof emotionSchema>;
export type Hands = z.infer<typeof handsSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Camera = z.infer<typeof cameraSchema>;
export type Fx = z.infer<typeof fxSchema>;
export type StoryNode = z.infer<typeof storyNodeSchema>;
export type MediaType = z.infer<typeof mediaTypeSchema>;
