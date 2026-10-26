import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../src";

const envelope = (type: string, payload: unknown) => ({
  v: 1,
  type,
  sessionId: "session-1",
  turnId: 3,
  seq: 0,
  ts: 1_700_000_000_000,
  payload,
});

describe("client message: playback_started（§6）", () => {
  it("接受合法的 playback_started", () => {
    const parsed = parseClientMessage(envelope("playback_started", { turnId: 3, seq: 2, clientMs: 1_234.5 }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe("playback_started");
  });

  it("拒绝缺字段或非法值", () => {
    expect(parseClientMessage(envelope("playback_started", { turnId: 3, seq: 2 })).success).toBe(false);
    expect(parseClientMessage(envelope("playback_started", { turnId: 3, seq: 2, clientMs: -1 })).success).toBe(false);
    expect(parseClientMessage(envelope("playback_started", { turnId: -1, seq: 2, clientMs: 1 })).success).toBe(false);
    expect(parseClientMessage(envelope("playback_started", { turnId: 3, seq: 2.5, clientMs: 1 })).success).toBe(false);
  });
});
