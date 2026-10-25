import { z } from "zod";
import { beatSchema, mediaSchema, storyStepSchema, type Beat, type Media, type StoryStep } from "./beat";
import {
  actionSchema,
  cameraSchema,
  emotionSchema,
  fxSchema,
  poseSchema,
  type Action,
  type Camera,
  type Emotion,
  type Fx,
  type Pose,
} from "./enums";

export type BeatParseResult = {
  beat: Beat;
  warnings: string[];
};

const EMPTY_BEAT: Beat = {
  seq: 0,
  say: "",
  emotion: "neutral",
  pose: "sit",
  action: null,
  camera: null,
  fx: null,
  media: null,
  story: null,
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
      warnings: ["beat 输入不是对象，已回退为 neutral/sit 的空 beat"],
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
  const pose = enumField<Pose>(poseSchema, input.pose, "sit", "pose", "sit", warnings);
  const action = nullableObject<Action>(actionSchema, input.action, "action", warnings);
  const camera = nullableObject<Camera>(cameraSchema, input.camera, "camera", warnings);
  const fx = nullableObject<Fx>(fxSchema, input.fx, "fx", warnings);
  const media = nullableObject<Media>(mediaSchema, input.media, "media", warnings);
  const story = nullableObject<StoryStep>(storyStepSchema, input.story, "story", warnings);

  const beat: Beat = {
    seq,
    say,
    emotion,
    pose,
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
