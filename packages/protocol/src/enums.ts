import { z } from "zod";

export const emotionSchema = z.enum(["neutral", "calm", "guarded", "sad", "warm", "surprised"]);
export const poseSchema = z.enum(["sit", "hold_cup", "look_down", "lean_in"]);
export const actionSchema = z.enum(["glance_door", "sip_coffee", "check_phone", "smile_softly"]);
export const cameraSchema = z.enum(["wide", "close_up"]);
export const fxSchema = z.enum(["rain_heavy", "rain_stop", "lights_dim", "warm_glow"]);
export const storyNodeSchema = z.enum(["arrive", "probe", "reveal", "ending"]);
export const mediaTypeSchema = z.enum(["video", "image"]);

export type Emotion = z.infer<typeof emotionSchema>;
export type Pose = z.infer<typeof poseSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Camera = z.infer<typeof cameraSchema>;
export type Fx = z.infer<typeof fxSchema>;
export type StoryNode = z.infer<typeof storyNodeSchema>;
export type MediaType = z.infer<typeof mediaTypeSchema>;
