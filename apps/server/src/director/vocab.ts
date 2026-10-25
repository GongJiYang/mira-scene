import type { Action, Emotion, Hands } from "@mira/protocol";

/**
 * D29：情绪 → Fish Audio 指令标签。
 * 只用于拼 TTS 文本，不发给客户端；集中放表，P3 实测听感后调整。
 * `null` 表示不加标签。
 */
export const FISH_EMOTION_TAGS: Record<Emotion, string | null> = {
  neutral: null,
  calm: "[calm]",
  guarded: "[soft tone]",
  sad: "[sad]",
  warm: "[gentle]",
  surprised: "[surprised]",
};

/**
 * D29 §2.1：动作 → 手部状态。
 * `null` 表示保持当前手部状态（glance_window 只转视线）。
 */
export const ACTION_HANDS: Record<Action, Hands | null> = {
  sip_coffee: "cup",
  show_polaroid: "polaroid",
  check_phone: "phone",
  glance_window: null,
};

/** TTS 文本 = Fish 标签 + 台词；台词为空时也为空。 */
export function buildTtsText(emotion: Emotion, say: string): string {
  if (say === "") return "";
  const tag = FISH_EMOTION_TAGS[emotion];
  return tag === null ? say : `${tag} ${say}`;
}
