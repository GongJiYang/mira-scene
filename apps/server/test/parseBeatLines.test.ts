import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { llmBeatSchema, parseLlmBeatLenient } from "@mira/protocol";
import { parseBeatLines, sanitizeBeatLine } from "../src/adapters/deepseek/parseBeatLines";

describe("parseBeatLines", () => {
  it("按行解析 JSON 对象，未结束的尾巴留在 carry", () => {
    const first = parseBeatLines('{"say":"一"}\n{"say":"二"}\n{"say":"三', "");
    expect(first.beats).toEqual([{ say: "一" }, { say: "二" }]);
    expect(first.carry).toBe('{"say":"三');
    expect(first.warnings).toEqual([]);

    const second = parseBeatLines('"}\n', first.carry);
    expect(second.beats).toEqual([{ say: "三" }]);
    expect(second.carry).toBe("");
  });

  it("去掉 ```json 代码块包裹", () => {
    const chunk = '```json\n{"say":"雨还在下。","emotion":"calm"}\n{"say":"先坐吧。"}\n```\n';
    const { beats, warnings } = parseBeatLines(chunk, "");
    expect(beats).toEqual([{ say: "雨还在下。", emotion: "calm" }, { say: "先坐吧。" }]);
    expect(warnings).toEqual([]);
  });

  it("坏行降级为纯台词并写 warning", () => {
    const { beats, warnings } = parseBeatLines("这不是 JSON\n{\"say\":\"好的\"}\n", "");
    expect(beats).toEqual([{ say: "这不是 JSON", emotion: "neutral" }, { say: "好的" }]);
    expect(warnings).toHaveLength(1);
  });

  it("非对象的 JSON 行（数组/数字）也降级为纯台词", () => {
    const { beats, warnings } = parseBeatLines("[1,2,3]\n42\n", "");
    expect(beats).toEqual([
      { say: "[1,2,3]", emotion: "neutral" },
      { say: "42", emotion: "neutral" },
    ]);
    expect(warnings).toHaveLength(2);
  });

  it("空行与单独的围栏行跳过", () => {
    const { beats } = parseBeatLines("\n   \n```\n{\"say\":\"好\"}\n", "");
    expect(beats).toEqual([{ say: "好" }]);
  });

  it("① 粘连的 JSON 行按 }{ 拆开后逐段解析（允许中间空白）", () => {
    const glued = parseBeatLines('{"say":"甲","emotion":"calm"}{"say":"乙"}\n', "");
    expect(glued.beats).toEqual([{ say: "甲", emotion: "calm" }, { say: "乙" }]);

    const spaced = parseBeatLines('{"say":"丙"}  {"say":"丁"}\n', "");
    expect(spaced.beats).toEqual([{ say: "丙" }, { say: "丁" }]);
  });

  it("② 坏行用正则提取 say 与 emotion（找不到 say 则不产出）", () => {
    const withEmotion = parseBeatLines('assistant said {"say":"雨停了","emotion":"sad"} (end)\n', "");
    expect(withEmotion.beats).toEqual([{ say: "雨停了", emotion: "sad" }]);
    expect(withEmotion.warnings).toHaveLength(1);

    const noEmotion = parseBeatLines('prefix {"say":"好的"} suffix\n', "");
    expect(noEmotion.beats).toEqual([{ say: "好的", emotion: "neutral" }]);
  });

  it("③ 看起来像 JSON 但提取不出的坏行被丢弃，只写 warning", () => {
    const truncated = parseBeatLines('{"say":"没说完\n', "");
    expect(truncated.beats).toEqual([]);
    expect(truncated.warnings).toHaveLength(1);

    const noSay = parseBeatLines('{"foo": 1,,bad}\n', "");
    expect(noSay.beats).toEqual([]);
    expect(noSay.warnings).toHaveLength(1);

    const colonNoise = parseBeatLines('他说":这不对劲\n', "");
    expect(colonNoise.beats).toEqual([]);
    expect(colonNoise.warnings).toHaveLength(1);
  });

  it("④ 完全不像 JSON 的纯文本才降级为台词", () => {
    const { beats, warnings } = parseBeatLines("这不是 JSON，只是旁白\n", "");
    expect(beats).toEqual([{ say: "这不是 JSON，只是旁白", emotion: "neutral" }]);
    expect(warnings).toHaveLength(1);
  });

  it("sanitizeBeatLine 去掉围栏与空白", () => {
    expect(sanitizeBeatLine("  ```json  ")).toBe("");
    expect(sanitizeBeatLine('  {"a":1}```  ')).toBe('{"a":1}');
    expect(sanitizeBeatLine("  {\"a\":1}  ")).toBe('{"a":1}');
  });
});

describe("属性：parseBeatLines 是总函数", () => {
  const chunkArb = fc.oneof(
    fc.string(),
    fc.constantFrom(
      '{"say":"雨还在下。","emotion":"calm"}\n',
      '{"say":"先坐吧。","advance":"probe"}\n',
      "```json\n",
      "```\n",
      "{坏掉的行\n",
      "\n",
      "  \n",
      "[1,2]\n",
      '"裸字符串"\n',
      '{"say":"a","emotion":"angry"}\n',
      '{"say":"多行","emotion":"sad"}',
    ),
  );

  it("600 次：任意文本流不抛错，输出经宽松解析总能通过 LlmBeat schema", () => {
    fc.assert(
      fc.property(fc.array(chunkArb, { maxLength: 40 }), (chunks) => {
        let carry = "";
        const beats: unknown[] = [];
        const warnings: string[] = [];
        for (const chunk of chunks) {
          const result = parseBeatLines(chunk, carry);
          carry = result.carry;
          beats.push(...result.beats);
          warnings.push(...result.warnings);
        }
        const flushed = parseBeatLines("\n", carry);
        beats.push(...flushed.beats);
        warnings.push(...flushed.warnings);

        for (const beat of beats) {
          const lenient = parseLlmBeatLenient(beat);
          expect(llmBeatSchema.safeParse(lenient.llmBeat).success).toBe(true);
        }
        expect(Array.isArray(warnings)).toBe(true);
      }),
      { numRuns: 600 },
    );
  });
});

describe("属性：坏行不会把 JSON 符号带进台词（s3-fix §1）", () => {
  const SAFE_CHARS = ["雨", "还", "在", "下", "。", "先", "坐", "吧", "嗯", "，", "！", "？", "停", "了"] as const;
  const safeText = fc.array(fc.constantFrom(...SAFE_CHARS), { maxLength: 8 }).map((parts) => parts.join(""));
  const emotionArb = fc.constantFrom("neutral", "calm", "sad", "warm", "guarded", "surprised");
  const jsonLine = fc
    .tuple(safeText, emotionArb)
    .map(([say, emotion]) => `{"say":${JSON.stringify(say)},"emotion":${JSON.stringify(emotion)}}`);
  const gluedLine = fc.tuple(jsonLine, jsonLine).map(([a, b]) => `${a}${b}`);
  const spacedGluedLine = fc.tuple(jsonLine, jsonLine).map(([a, b]) => `${a} ${b}`);
  const truncatedLine = fc.tuple(jsonLine, fc.nat()).map(([line, cut]) => line.slice(0, cut % (line.length + 1)));
  const lineArb = fc.oneof(jsonLine, gluedLine, spacedGluedLine, truncatedLine, safeText);

  it("600 次：JSON 行 / 粘连行 / 截断行 / 纯文本行 → 输出的 say 不含 {\" 或 \":\"", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 24 }), (lines) => {
        const { beats } = parseBeatLines(`${lines.join("\n")}\n`, "");
        for (const beat of beats) {
          if (typeof beat !== "object" || beat === null || !("say" in beat)) continue;
          const say = (beat as { say: unknown }).say;
          if (typeof say !== "string") continue;
          expect(say).not.toContain('{"');
          expect(say).not.toContain('":');
        }
      }),
      { numRuns: 600 },
    );
  });
});
