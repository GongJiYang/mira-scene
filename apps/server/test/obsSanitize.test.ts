/**
 * S6h §4：sanitize 属性测试。
 * 任意 detail（含字符串、嵌套对象、像 Key 的串）进去，
 * 出来的记录里不会有非白名单字段、不会有任何字符串长度 > 40 的值。
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { sanitize } from "../src/obs/sanitize";
import type { LogRecord } from "../src/log";

const WHITELIST = new Set([
  "code",
  "status",
  "port",
  "provider",
  "reason",
  "scope",
  "category",
  "input",
  "bytes",
  "limit",
  "used",
  "chars",
  "seq",
  "clientMs",
  "first_audio_ms",
  "server_ms",
  "duration_ms",
  "afterBeat",
  "last",
  "incoming",
  "cps",
  "silent",
  "suggestAccepted",
  "advanceAccepted",
]);

/** 任意 JSON 值（含嵌套、Key 样式字符串）。 */
const arbValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string(),
  fc.stringMatching(/sk-[a-zA-Z0-9]{10,40}/),
  fc.stringMatching(/AKIA[A-Z0-9]{16}/),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.string(), { maxLength: 4 }),
  fc.dictionary(fc.string(), fc.string(), { maxKeys: 4 }),
);

const arbRecord: fc.Arbitrary<LogRecord> = fc.record({
  ts: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  sessionId: fc.option(fc.uuid(), { nil: undefined }),
  turnId: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined }),
  event: fc.string({ minLength: 0, maxLength: 40 }),
  ms: fc.option(fc.double(), { nil: undefined }),
  detail: fc.option(fc.dictionary(fc.string(), arbValue, { maxKeys: 8 }), { nil: undefined }),
});

/** 递归断言 detail 里所有字符串 ≤ 40（含省略号）。 */
function assertNoLongStrings(value: unknown): void {
  if (typeof value === "string") {
    expect(value.length).toBeLessThanOrEqual(41); // 40 + 省略号
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) assertNoLongStrings(v);
  }
}

describe("sanitize", () => {
  it("属性：任意 detail 进去，输出只含白名单字段，且字符串值 ≤ 40", () => {
    fc.assert(
      fc.property(arbRecord, (record) => {
        const out = sanitize(record);
        // 顶层字段固定。
        const keys = Object.keys(out).sort();
        for (const key of keys) {
          expect(["ts", "sessionId", "turnId", "event", "ms", "detail"]).toContain(key);
        }
        if (out.detail !== undefined) {
          for (const key of Object.keys(out.detail)) {
            expect(WHITELIST.has(key)).toBe(true);
          }
          assertNoLongStrings(out.detail);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("Key 样式字符串不会进 detail（非白名单字段被丢弃）", () => {
    const out = sanitize({
      ts: 1,
      event: "llm_usage",
      detail: {
        apiKey: "sk-abc1234567890abcdef",
        prompt: "给用户看的提示词",
        text: "用户输入的文字",
        say: "台词",
        token: "AKIAIOSFODNN7EXAMPLE",
        code: "llm_timeout", // 白名单枚举，保留
      },
    });
    expect(out.detail).toEqual({ code: "llm_timeout" });
    expect(JSON.stringify(out)).not.toContain("sk-");
    expect(JSON.stringify(out)).not.toContain("提示词");
    expect(JSON.stringify(out)).not.toContain("用户输入");
    expect(JSON.stringify(out)).not.toContain("台词");
    expect(JSON.stringify(out)).not.toContain("AKIA");
  });

  it("嵌套对象被整体丢弃（白名单字段也只收标量）", () => {
    const out = sanitize({
      ts: 1,
      event: "x",
      detail: { code: { nested: "value" }, bytes: 1024 },
    });
    expect(out.detail).toEqual({ bytes: 1024 });
  });

  it("duration_ms 是白名单数值（commandcode LLM 耗时保留）", () => {
    const out = sanitize({ ts: 1, event: "llm_usage", detail: { duration_ms: 2597, total_tokens: 120 } });
    expect(out.detail).toEqual({ duration_ms: 2597 });
  });

  it("detail 不是对象（数组 / 标量 / null）时 detail 不输出", () => {
    expect(sanitize({ ts: 1, event: "x", detail: "hello" }).detail).toBeUndefined();
    expect(sanitize({ ts: 1, event: "x", detail: [1, 2] }).detail).toBeUndefined();
    expect(sanitize({ ts: 1, event: "x", detail: null }).detail).toBeUndefined();
    expect(sanitize({ ts: 1, event: "x" }).detail).toBeUndefined();
  });

  it("detail 全被丢光时不输出空对象", () => {
    const out = sanitize({ ts: 1, event: "x", detail: { message: "会被丢掉的错误消息" } });
    expect(out.detail).toBeUndefined();
  });

  it("超长白名单字符串截断到 40", () => {
    const longReason = "r".repeat(120);
    const out = sanitize({ ts: 1, event: "x", detail: { reason: longReason } });
    const value = out.detail?.reason;
    expect(typeof value).toBe("string");
    expect((value as string).length).toBeLessThanOrEqual(41);
  });

  it("ms 非有限值时丢弃", () => {
    expect(sanitize({ ts: 1, event: "x", ms: Number.NaN }).ms).toBeUndefined();
    expect(sanitize({ ts: 1, event: "x", ms: Number.POSITIVE_INFINITY }).ms).toBeUndefined();
    expect(sanitize({ ts: 1, event: "x", ms: 42 }).ms).toBe(42);
  });
});
