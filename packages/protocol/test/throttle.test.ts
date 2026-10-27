/**
 * S6l-fix2 §6：poke / gift 的限流（服务端与客户端共享常量 + 纯函数）。
 *
 * 客户端有冷却，但服务端没有——重复请求（多标签页 / 重放）会起新轮并扣轮数。
 * 服务端按会话限流：poke 3 秒、gift 10 秒内的重复请求直接忽略。
 */
import { describe, expect, it } from "vitest";
import { GIFT_COOLDOWN_MS, POKE_COOLDOWN_MS, throttleEvent } from "@mira/protocol";

describe("throttleEvent：按上次触发时刻判定是否放行（S6l-fix2 §6）", () => {
  it("首次（lastAt 为 null / undefined）→ 放行", () => {
    expect(throttleEvent(null, 1_000, "poke")).toBe(true);
    expect(throttleEvent(undefined, 1_000, "gift")).toBe(true);
  });

  it("poke：冷却 3 秒内的重复 → 忽略；3 秒后 → 放行", () => {
    expect(POKE_COOLDOWN_MS).toBe(3_000);
    expect(throttleEvent(1_000, 1_000 + POKE_COOLDOWN_MS - 1, "poke")).toBe(false);
    expect(throttleEvent(1_000, 1_000 + POKE_COOLDOWN_MS, "poke")).toBe(true);
  });

  it("gift：冷却 10 秒内的重复 → 忽略；10 秒后 → 放行", () => {
    expect(GIFT_COOLDOWN_MS).toBe(10_000);
    expect(throttleEvent(1_000, 1_000 + GIFT_COOLDOWN_MS - 1, "gift")).toBe(false);
    expect(throttleEvent(1_000, 1_000 + GIFT_COOLDOWN_MS, "gift")).toBe(true);
  });

  it("时间回退（now < lastAt）→ 忽略（避免时钟异常时刷屏）", () => {
    expect(throttleEvent(5_000, 4_000, "poke")).toBe(false);
  });
});
