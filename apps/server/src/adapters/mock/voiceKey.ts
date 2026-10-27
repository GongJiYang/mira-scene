/**
 * Mock 语音方案 B（S5 §1）：台词 + 情绪 → 稳定查表键。
 *
 * 纯函数（架构关卡 §3）：同一句台词 + 同一情绪必须得到同一个键，进程重启后也不变。
 * 键只取决于「规整后的文本 + 情绪」，不依赖剧情节点，因此以后与 E1 实时语音复用同一端口时无需改动。
 */
import { createHash } from "node:crypto";
import type { Emotion } from "@mira/protocol";

/**
 * 表意标点 → 半角等价值。
 * NFKC 只处理「全角形式」（U+FFxx，如 `，！？`），不处理 `。、` 这类表意标点，所以单独补一张表。
 */
const PUNCTUATION_MAP: Readonly<Record<string, string>> = {
  "。": ".",
  "、": ",",
  "〔": "(",
  "〕": ")",
  "【": "[",
  "】": "]",
  "「": '"',
  "」": '"',
  "『": '"',
  "』": '"',
  "《": "<",
  "》": ">",
  "〈": "<",
  "〉": ">",
  "—": "-",
  "–": "-",
  "―": "-",
  "・": ".",
  "·": ".",
  "～": "~",
};

/**
 * 文本规整（§1）：
 * 1. `NFKC` 统一全角/半角（标点、字母、数字都归一）；
 * 2. 表意标点按 `PUNCTUATION_MAP` 再统一一次（`。` → `.` 等）；
 * 3. 去掉首尾空白；
 * 4. 中间的连续空白压成一个空格。
 */
export function normalizeVoiceText(text: string): string {
  const unified = [...text.normalize("NFKC")].map((char) => PUNCTUATION_MAP[char] ?? char).join("");
  return unified.trim().replace(/\s+/g, " ");
}

/** 稳定哈希截断长度（十六进制字符数）。 */
export const VOICE_KEY_LENGTH = 16;

/**
 * `voiceKey(text, emotion) → string`。
 * 文本先规整再做 sha256，取前 16 个十六进制字符作为文件名友好的短键。
 */
export function voiceKey(text: string, emotion: Emotion): string {
  const normalized = normalizeVoiceText(text);
  return createHash("sha256").update(`${emotion}\u0000${normalized}`, "utf8").digest("hex").slice(0, VOICE_KEY_LENGTH);
}
