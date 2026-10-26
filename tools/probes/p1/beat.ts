import type { LlmBeat } from "@mira/protocol";
import {
  actionSchema,
  emotionSchema,
  llmBeatSchema,
  parseLlmBeatLenient,
  storyNodeSchema,
} from "@mira/protocol";

/** 一次调用里解析出来的一个「beat 单元」（a = 一行、e = 一句、b = 数组的一个元素）。 */
export type BeatUnit = {
  /** 单元完成时的流内时间（ms）。 */
  atMs: number;
  rawText: string;
  /** 不经宽松修正即可通过 llmBeatSchema。 */
  strictValid: boolean;
  /** emotion / suggest / advance 都在枚举内（缺省视为合法）。 */
  enumValid: boolean;
  beat: LlmBeat | null;
  /** 宽松解析（parseLlmBeatLenient）：只用于展示与对照，不计入成功率。 */
  lenient: LlmBeat;
};

export const EMOTIONS = emotionSchema.options;
export const ACTIONS = actionSchema.options;
export const STORY_NODES = storyNodeSchema.options;

function inEnum(options: readonly string[], value: unknown, optional: boolean): boolean {
  if (value === undefined || value === null) return optional;
  return typeof value === "string" && options.includes(value);
}

export function judgeUnit(atMs: number, rawText: string, raw: unknown): BeatUnit {
  const parsed = llmBeatSchema.safeParse(raw);
  const object = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    atMs,
    rawText,
    strictValid: parsed.success,
    enumValid:
      inEnum(EMOTIONS, object.emotion, false) &&
      inEnum(ACTIONS, object.suggest, true) &&
      inEnum(STORY_NODES, object.advance, true),
    beat: parsed.success ? parsed.data : null,
    lenient: parseLlmBeatLenient(raw).llmBeat,
  };
}

/** 句子字数：按 Unicode 字符数，去掉首尾空白。 */
export function sayLength(say: string): number {
  return [...say.trim()].length;
}
