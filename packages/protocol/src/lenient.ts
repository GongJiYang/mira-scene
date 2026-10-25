import { z } from "zod";
import {
  beatSchema,
  llmBeatSchema,
  mediaSchema,
  storyStepSchema,
  type Beat,
  type Media,
  type StoryStep,
} from "./beat";
import {
  actionSchema,
  cameraSchema,
  emotionSchema,
  fxSchema,
  handsSchema,
  storyNodeSchema,
  type Action,
  type Camera,
  type Emotion,
  type Fx,
  type Hands,
  type StoryNode,
} from "./enums";

export type BeatParseResult = {
  beat: Beat;
  warnings: string[];
};

/** parseLlmBeatLenient 的规范化输出：可选的 suggest / advance 统一为 null。 */
export type NormalizedLlmBeat = {
  say: string;
  emotion: Emotion;
  suggest: Action | null;
  advance: StoryNode | null;
};

export type LlmBeatParseResult = {
  llmBeat: NormalizedLlmBeat;
  warnings: string[];
};

const EMPTY_BEAT: Beat = {
  seq: 0,
  say: "",
  emotion: "neutral",
  hands: "cup",
  action: null,
  camera: null,
  fx: null,
  media: null,
  story: null,
};

const EMPTY_LLM_BEAT: NormalizedLlmBeat = {
  say: "",
  emotion: "neutral",
  suggest: null,
  advance: null,
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const preview = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

function enumField<T>(
  schema: z.ZodType<T>,
  value: unknown,
  fallback: T,
  field: string,
  fallbackLabel: string,
  warnings: string[],
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  warnings.push(`${field} ${preview(value)} 非法，已降级为 ${fallbackLabel}`);
  return fallback;
}

function nullableObject<T>(
  schema: z.ZodType<T>,
  value: unknown,
  field: string,
  warnings: string[],
): T | null {
  if (value === undefined || value === null) return null;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  warnings.push(`${field} ${preview(value)} 非法，已降级为 null`);
  return null;
}

/**
 * 宽松解析 beat：永不抛错，非法字段按 S1 规则降级并记录 warning。
 */
export function parseBeatLenient(input: unknown): BeatParseResult {
  if (!isPlainObject(input)) {
    return {
      beat: { ...EMPTY_BEAT },
      warnings: ["beat 输入不是对象，已回退为 neutral/cup 的空 beat"],
    };
  }

  const warnings: string[] = [];

  const rawSeq = input.seq;
  let seq = 0;
  if (typeof rawSeq === "number" && Number.isInteger(rawSeq) && rawSeq >= 0) {
    seq = rawSeq;
  } else {
    warnings.push(`seq ${preview(rawSeq)} 非法，已修正为 0`);
  }

  const rawSay = input.say;
  let say = "";
  if (typeof rawSay === "string") {
    say = rawSay;
  } else {
    warnings.push(`say ${preview(rawSay)} 不是字符串，已回退为空串`);
  }

  const emotion = enumField<Emotion>(emotionSchema, input.emotion, "neutral", "emotion", "neutral", warnings);
  const hands = enumField<Hands>(handsSchema, input.hands, "cup", "hands", "cup", warnings);
  const action = nullableObject<Action>(actionSchema, input.action, "action", warnings);
  const camera = nullableObject<Camera>(cameraSchema, input.camera, "camera", warnings);
  const fx = nullableObject<Fx>(fxSchema, input.fx, "fx", warnings);
  const media = nullableObject<Media>(mediaSchema, input.media, "media", warnings);
  const story = nullableObject<StoryStep>(storyStepSchema, input.story, "story", warnings);

  const beat: Beat = {
    seq,
    say,
    emotion,
    hands,
    action,
    camera,
    fx,
    media,
    story,
  };

  // 防御：上述构造应始终合法；若未来 schema 收紧，这里保证返回值仍是合法 Beat。
  if (!beatSchema.safeParse(beat).success) {
    return { beat: { ...EMPTY_BEAT }, warnings: [...warnings, "beat 组装后仍未通过 schema，已回退为空 beat"] };
  }

  return { beat, warnings };
}

/**
 * 宽松解析 LLM 原始输出（契约 ①）：永不抛错。
 * 非法 emotion → neutral；非法 suggest / advance → null；say 缺失 → 空串；非对象 → neutral 空 beat。
 */
export function parseLlmBeatLenient(input: unknown): LlmBeatParseResult {
  if (!isPlainObject(input)) {
    return {
      llmBeat: { ...EMPTY_LLM_BEAT },
      warnings: ["llmBeat 输入不是对象，已回退为 neutral 的空 beat"],
    };
  }

  const warnings: string[] = [];

  const rawSay = input.say;
  let say = "";
  if (typeof rawSay === "string") {
    say = rawSay;
  } else {
    warnings.push(`say ${preview(rawSay)} 不是字符串，已回退为空串`);
  }

  const emotion = enumField<Emotion>(emotionSchema, input.emotion, "neutral", "emotion", "neutral", warnings);
  const suggest = nullableObject<Action>(actionSchema, input.suggest, "suggest", warnings);
  const advance = nullableObject<StoryNode>(storyNodeSchema, input.advance, "advance", warnings);

  const llmBeat: NormalizedLlmBeat = { say, emotion, suggest, advance };

  if (!llmBeatSchema.safeParse(llmBeat).success) {
    return {
      llmBeat: { ...EMPTY_LLM_BEAT },
      warnings: [...warnings, "llmBeat 组装后仍未通过 schema，已回退为空 beat"],
    };
  }

  return { llmBeat, warnings };
}
