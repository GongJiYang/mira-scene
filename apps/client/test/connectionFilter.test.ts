import { describe, expect, it } from "vitest";
import { shouldAcceptMessage } from "../src/core/connection";

/**
 * S6b-fix1 §3：切频道后客户端只接受新会话的消息。
 * - 等待新会话期间：只接受 session（锁定新 id），旧消息一律丢弃（不覆盖存储）。
 * - S6b-fix2 §1：等待期间 pong 一律接受（心跳不断线）；error 接受并结束等待（进入错误态）。
 * - 锁定新 sessionId 后：旧 sessionId 的消息一律丢弃。
 */
describe("shouldAcceptMessage（S6b-fix1 §3 切频道消息过滤）", () => {
  it("等待新会话期间：session 锁定，其余一律丢弃", () => {
    expect(shouldAcceptMessage(true, null, { type: "session", sessionId: "new" })).toBe("lock");
    expect(shouldAcceptMessage(true, null, { type: "media_ready", sessionId: "old" })).toBe("drop");
    expect(shouldAcceptMessage(true, null, { type: "beat", sessionId: "old" })).toBe("drop");
    expect(shouldAcceptMessage(true, null, { type: "tts_audio", sessionId: "old" })).toBe("drop");
  });

  it("S6b-fix2 §1：等待新会话期间 pong 一律接受、会话级 error 接受（结束等待）", () => {
    expect(shouldAcceptMessage(true, null, { type: "pong", sessionId: "" })).toBe("accept");
    expect(shouldAcceptMessage(true, null, { type: "pong", sessionId: "old" })).toBe("accept");
    expect(
      shouldAcceptMessage(true, null, { type: "error", sessionId: "hello-stale", scope: "session" }),
    ).toBe("accept");
  });

  it("S6b-fix3 §1：等待新会话期间轮次级 error 被丢弃，不能结束等待", () => {
    expect(shouldAcceptMessage(true, null, { type: "error", sessionId: "hello-stale" })).toBe("drop");
    expect(
      shouldAcceptMessage(true, null, { type: "error", sessionId: "hello-stale", scope: "turn" }),
    ).toBe("drop");
  });

  it("锁定新 sessionId 后：旧 sessionId 的消息被丢弃，新会话的接受", () => {
    expect(shouldAcceptMessage(false, "new", { type: "media_ready", sessionId: "old" })).toBe("drop");
    expect(shouldAcceptMessage(false, "new", { type: "beat", sessionId: "old" })).toBe("drop");
    expect(shouldAcceptMessage(false, "new", { type: "beat", sessionId: "new" })).toBe("accept");
    expect(shouldAcceptMessage(false, "new", { type: "media_ready", sessionId: "new" })).toBe("accept");
  });

  it("传输层心跳 pong 不按 sessionId 过滤", () => {
    expect(shouldAcceptMessage(false, "new", { type: "pong", sessionId: "old" })).toBe("accept");
    expect(shouldAcceptMessage(false, "new", { type: "pong", sessionId: "" })).toBe("accept");
  });

  it("未锁定任何会话（knownSessionId 为 null）时全部接受", () => {
    expect(shouldAcceptMessage(false, null, { type: "session", sessionId: "s1" })).toBe("accept");
    expect(shouldAcceptMessage(false, null, { type: "beat", sessionId: "s1" })).toBe("accept");
  });
});
