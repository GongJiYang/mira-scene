/**
 * S6c §2：Mock 场景扩写（`SceneWriterPort` 的 Mock 实现）。
 *
 * 按关键词查表返回固定 spec，没有 Key 也能完整演示（Q10）。
 * 查表规则（至少 3 条）：
 * - 含「海」→ 黄昏海边；
 * - 含「雨」→ 雨夜；
 * - 其它（含含糊请求）→ 示例里的「随便换」那条（深夜天台）。
 */
import type { SceneWriterPort, SceneWriteContext } from "../../ports";

/** 查表条目：关键词 → spec。 */
const TABLE: ReadonlyArray<{ pattern: RegExp; spec: unknown }> = [
  {
    pattern: /海/,
    spec: {
      accept: true,
      location: "a quiet sandy beach",
      time: "sunset",
      lighting: "warm low sun with soft lavender sky",
      props: ["a beach blanket under the cushion", "a small lantern", "a beach umbrella"],
      palette: "lavender, soft pink, warm orange",
      mood: "calm and a little lonely",
      label: "黄昏海边",
      note: "观众把背景换成了黄昏的海边",
    },
  },
  {
    pattern: /雨/,
    spec: {
      accept: true,
      location: "a small rooftop terrace in the rain",
      time: "rainy night",
      lighting: "city glow through rain with warm string lights",
      props: ["a small potted plant", "a folding chair", "rain lines in the light"],
      palette: "teal, warm amber, grey",
      mood: "quiet and wistful",
      label: "雨夜露台",
      note: "观众把背景换成了雨夜的露台",
    },
  },
];

/** 含糊请求（「随便换」「换个好看的」等）→ 深夜天台。 */
const FALLBACK_SPEC: unknown = {
  accept: true,
  location: "a rooftop of an old apartment building",
  time: "late night",
  lighting: "city glow and a few string lights",
  props: ["a small potted plant", "a folding chair", "distant neon signs without text"],
  palette: "deep purple, navy, soft pink",
  mood: "quiet and nostalgic",
  label: "深夜天台",
  note: "观众让你随便换，你挑了一个深夜的天台",
};

/**
 * 创建 Mock 场景扩写端口。
 * 查表命中 → 返回对应 spec 的 JSON 字符串；否则返回 FALLBACK_SPEC。
 */
export function createMockSceneWriter(): SceneWriterPort {
  return {
    async write(ctx: SceneWriteContext, signal): Promise<unknown> {
      if (signal.aborted) throw new Error("aborted");
      const text = ctx.userText;
      for (const { pattern, spec } of TABLE) {
        if (pattern.test(text)) return JSON.stringify(spec);
      }
      return JSON.stringify(FALLBACK_SPEC);
    },
  };
}
