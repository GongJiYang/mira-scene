import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  isHeartbeatExpired,
  jitteredDelay,
} from "../src/core/heartbeat";

describe("心跳超时判定", () => {
  it("15s 心跳间隔、30s 超时（D8）", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(HEARTBEAT_TIMEOUT_MS).toBe(30_000);
  });

  it("29.999s 未收到 pong 不算断线，30s 判定断线", () => {
    const lastPongAt = 1_000;
    expect(isHeartbeatExpired(lastPongAt, lastPongAt + 29_999)).toBe(false);
    expect(isHeartbeatExpired(lastPongAt, lastPongAt + 30_000)).toBe(true);
    expect(isHeartbeatExpired(lastPongAt, lastPongAt + 45_000)).toBe(true);
  });
});

describe("重连退避抖动", () => {
  it("±20%：random=0 → 0.8x，0.5 → 1x，1 → 1.2x", () => {
    expect(jitteredDelay(1_000, 0)).toBe(800);
    expect(jitteredDelay(1_000, 0.5)).toBe(1_000);
    expect(jitteredDelay(1_000, 1)).toBe(1_200);
  });

  it("始终落在 ±20% 区间内", () => {
    for (const random of [0, 0.1, 0.33, 0.7, 0.99, 1]) {
      const delay = jitteredDelay(10_000, random);
      expect(delay).toBeGreaterThanOrEqual(8_000);
      expect(delay).toBeLessThanOrEqual(12_000);
    }
  });

  it("越界 random 被夹到 [0,1]", () => {
    expect(jitteredDelay(1_000, -1)).toBe(800);
    expect(jitteredDelay(1_000, 2)).toBe(1_200);
  });
});
