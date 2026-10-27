import { describe, expect, it } from "vitest";
import { parseCmdNdjson } from "../src/adapters/commandcode/parseCmdNdjson";

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

function textDelta(delta: string): string {
  return line({ type: "event", event: { type: "text_delta", delta } });
}

describe("parseCmdNdjson（S6a §2）", () => {
  it("只产出 text_delta 的文本增量", () => {
    const chunk = textDelta("好") + textDelta("的") + line({ type: "event", event: { type: "turn_start" } });
    const result = parseCmdNdjson(chunk, "");
    expect(result.text).toBe("好的");
    expect(result.error).toBeNull();
    expect(result.done).toBe(false);
  });

  it("result.success → done，并取出 usage 里的数字", () => {
    const chunk = line({
      type: "result",
      subtype: "success",
      usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4 },
    });
    const result = parseCmdNdjson(chunk, "");
    expect(result.done).toBe(true);
    expect(result.error).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 4 });
  });

  it("result.subtype !== success → 报错", () => {
    const result = parseCmdNdjson(line({ type: "result", subtype: "error_max_turns" }), "");
    expect(result.done).toBe(true);
    expect(result.error).toContain("error_max_turns");
  });

  it("错误事件 → 报错", () => {
    const event = parseCmdNdjson(line({ type: "event", event: { type: "error", message: "boom" } }), "");
    expect(event.error).toContain("boom");
    const top = parseCmdNdjson(line({ type: "error", message: "top" }), "");
    expect(top.error).toContain("top");
  });

  it("坏行忽略，不影响其它行", () => {
    const chunk = "这不是 JSON\n" + textDelta("好") + "{坏行\n" + textDelta("的");
    const result = parseCmdNdjson(chunk, "");
    expect(result.text).toBe("好的");
    expect(result.error).toBeNull();
  });

  it("跨块的行缓冲：半个 JSON 留在 carry，下一块补齐", () => {
    const one = parseCmdNdjson(textDelta("你").slice(0, 20), "");
    expect(one.text).toBe("");
    expect(one.carry.length).toBeGreaterThan(0);

    const rest = textDelta("你").slice(20) + textDelta("好");
    const two = parseCmdNdjson(rest, one.carry);
    expect(two.text).toBe("你好");
  });

  it("流结束时用 \\n 冲掉最后一行（没有换行的尾巴）", () => {
    const tail = JSON.stringify({ type: "event", event: { type: "text_delta", delta: "末" } });
    const buffered = parseCmdNdjson(tail, "");
    expect(buffered.text).toBe("");
    const flushed = parseCmdNdjson("\n", buffered.carry);
    expect(flushed.text).toBe("末");
  });

  it("usage 只保留数字字段", () => {
    const result = parseCmdNdjson(
      line({ type: "result", subtype: "success", usage: { a: 1, b: "x", c: 2 } }),
      "",
    );
    expect(result.usage).toEqual({ a: 1, c: 2 });
  });
});
