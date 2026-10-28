import { describe, expect, it } from "vitest";
import {
  PHOTO_WAITING_FIRST_MS,
  PHOTO_WAITING_INTERVAL_MS,
  PHOTO_WAITING_MAX,
  photoWaitingDecision,
} from "../src/state/photoWaiting";

/**
 * freeze-fix3 §1/§4：截图生成期间的「边翻边聊」铺垫调度（纯函数）。
 * 输入：A 阶段、C 照片槽位状态、已铺垫次数、距 idle 时长 / 距上次铺垫时长 → 是否发 nudge。
 */
describe("photoWaitingDecision：铺垫调度（§1）", () => {
  const idle = (
    overrides: Partial<Parameters<typeof photoWaitingDecision>[0]> = {},
  ): Parameters<typeof photoWaitingDecision>[0] => ({
    phase: "idle",
    photoStatus: "developing",
    fired: 0,
    sinceIdleMs: PHOTO_WAITING_FIRST_MS,
    sinceLastMs: null,
    ...overrides,
  });

  it("常数符合契约：首次 1.5s、间隔 10s、上限 3", () => {
    expect(PHOTO_WAITING_FIRST_MS).toBe(1_500);
    expect(PHOTO_WAITING_INTERVAL_MS).toBe(10_000);
    expect(PHOTO_WAITING_MAX).toBe(3);
  });

  it("idle 后满 1.5s、截图仍在加载：发第一次", () => {
    expect(photoWaitingDecision(idle({ sinceIdleMs: PHOTO_WAITING_FIRST_MS })).send).toBe(true);
  });

  it("idle 不足 1.5s：不发", () => {
    expect(photoWaitingDecision(idle({ sinceIdleMs: PHOTO_WAITING_FIRST_MS - 1 })).send).toBe(false);
  });

  it("第一次之后，距上次不足 10s：不发", () => {
    const decision = photoWaitingDecision(
      idle({ fired: 1, sinceLastMs: PHOTO_WAITING_INTERVAL_MS - 1 }),
    );
    expect(decision.send).toBe(false);
  });

  it("第一次之后，距上次满 10s：发", () => {
    const decision = photoWaitingDecision(
      idle({ fired: 1, sinceLastMs: PHOTO_WAITING_INTERVAL_MS }),
    );
    expect(decision.send).toBe(true);
  });

  it("已铺垫 3 次：即使满足时间也不再发（上限）", () => {
    const decision = photoWaitingDecision(
      idle({ fired: PHOTO_WAITING_MAX, sinceLastMs: PHOTO_WAITING_INTERVAL_MS }),
    );
    expect(decision.send).toBe(false);
  });

  it("截图就绪（ready / shown）：不发", () => {
    expect(photoWaitingDecision(idle({ photoStatus: "ready" })).send).toBe(false);
    expect(photoWaitingDecision(idle({ photoStatus: "shown" })).send).toBe(false);
  });

  it("截图失败走兜底（fallback）：不发", () => {
    expect(photoWaitingDecision(idle({ photoStatus: "fallback" })).send).toBe(false);
  });

  it("没有截图事件（none）：不发", () => {
    expect(photoWaitingDecision(idle({ photoStatus: "none" })).send).toBe(false);
  });

  it("A 不是 idle（thinking / speaking / listening / error）：不发", () => {
    for (const phase of ["thinking", "speaking", "listening", "error"] as const) {
      expect(photoWaitingDecision(idle({ phase })).send).toBe(false);
    }
  });
});
