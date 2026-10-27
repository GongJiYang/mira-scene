/**
 * S6l-fix1 §1：`session` 消息新增 `background` / `transcript` 字段的 schema 测试。
 *
 * 新字段可选，缺省按 null / [] 处理，不破坏旧客户端解析。
 */
import { describe, expect, it } from "vitest";
import { parseServerMessage, sessionPayloadSchema } from "../src/messages";

const snapshot = {
  node: "arrive",
  trust: 0,
  flags: [],
  emotion: "neutral",
  hands: "cup",
  camera: null,
  fx: null,
  turnCount: 0,
};

describe("session payload（S6l-fix1 §1）", () => {
  it("不带 background / transcript 仍能解析（旧客户端兼容）", () => {
    const parsed = sessionPayloadSchema.safeParse({ snapshot });
    expect(parsed.success).toBe(true);
  });

  it("带 background（label + urls）与 transcript 解析成功", () => {
    const parsed = sessionPayloadSchema.safeParse({
      snapshot,
      background: { label: "黄昏海边", urls: { desktop: "/generated/a-desktop.png", mobile: "/generated/a-mobile.png" } },
      transcript: [
        { role: "user", text: "你好" },
        { role: "assistant", text: "嗯。\n也在。" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("boundary：background 为 null", () => {
    expect(sessionPayloadSchema.safeParse({ snapshot, background: null, transcript: [] }).success).toBe(true);
  });

  it("serverMessage 解析：session 带新字段", () => {
    const message = {
      v: 1,
      sessionId: "s1",
      turnId: 0,
      seq: 0,
      ts: 1,
      type: "session",
      payload: { snapshot, background: null, transcript: [{ role: "user", text: "hi" }] },
    };
    expect(parseServerMessage(message).success).toBe(true);
  });
});
