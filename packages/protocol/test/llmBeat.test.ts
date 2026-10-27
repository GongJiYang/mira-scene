import { describe, expect, it } from "vitest";
import { llmBeatSchema, parseLlmBeatLenient, type LlmBeatParseResult } from "../src";

describe("parseLlmBeatLenient", () => {
  it("合法 LlmBeat 原样保留且不产生 warning", () => {
    const input = { say: "雨停了。", emotion: "sad", suggest: "show_item", advance: "reveal" };
    const result = parseLlmBeatLenient(input);
    expect(result.warnings).toEqual([]);
    expect(result.llmBeat).toEqual(input);
    expect(llmBeatSchema.safeParse(result.llmBeat).success).toBe(true);
  });

  it("suggest / advance 缺省或为 null 时规范化为 null", () => {
    expect(parseLlmBeatLenient({ say: "嗯。", emotion: "calm" }).llmBeat).toEqual({
      say: "嗯。",
      emotion: "calm",
      suggest: null,
      advance: null,
    });
    expect(
      parseLlmBeatLenient({ say: "嗯。", emotion: "calm", suggest: null, advance: null }).warnings,
    ).toEqual([]);
  });

  it("非法 emotion 降级为 neutral 并写一条 warning", () => {
    const result = parseLlmBeatLenient({ say: "嗯。", emotion: "angry" });
    expect(result.llmBeat.emotion).toBe("neutral");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain("emotion");
  });

  it("非法 suggest / advance 降级为 null", () => {
    const result = parseLlmBeatLenient({ say: "嗯。", emotion: "calm", suggest: "wave", advance: "climax" });
    expect(result.llmBeat.suggest).toBeNull();
    expect(result.llmBeat.advance).toBeNull();
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join("\n")).toContain("suggest");
    expect(result.warnings.join("\n")).toContain("advance");
  });

  it("say 缺失或非字符串时降级为空串", () => {
    for (const say of [undefined, null, 42, ["台词"]]) {
      const result = parseLlmBeatLenient({ say, emotion: "calm" });
      expect(result.llmBeat.say).toBe("");
      expect(result.warnings.join("\n")).toContain("say");
    }
  });

  it.each([null, undefined, "text", 42, ["llm"]])(
    "非对象输入 %s 不抛错，返回 neutral 空 beat 和一条 warning",
    (input) => {
      let result: LlmBeatParseResult | undefined;
      expect(() => {
        result = parseLlmBeatLenient(input);
      }).not.toThrow();
      expect(result?.llmBeat).toEqual({ say: "", emotion: "neutral", suggest: null, advance: null });
      expect(result?.warnings).toHaveLength(1);
    },
  );
});
