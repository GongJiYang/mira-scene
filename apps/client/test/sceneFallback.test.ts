/**
 * S6c-fix1 §2：换背景失败 / 拒绝兜底的纯逻辑测试。
 *
 * 规则：只在角色不说话的空档（idle / listening）播放；thinking / speaking 排队；
 * 被打断不作废（pending 保留）。
 */
import { describe, expect, it } from "vitest";
import { isQuietPhase, sceneFallbackDecision } from "../src/live/scene/sceneFallback";

describe("sceneFallbackDecision（S6c-fix1 §2）", () => {
  it("无待播 → 任何 phase 都不播", () => {
    for (const phase of ["idle", "listening", "thinking", "speaking", "error"] as const) {
      expect(sceneFallbackDecision(phase, false).play).toBe(false);
    }
  });

  it("空档（idle / listening）+ 有待播 → 播", () => {
    expect(sceneFallbackDecision("idle", true).play).toBe(true);
    expect(sceneFallbackDecision("listening", true).play).toBe(true);
  });

  it("说话中（thinking / speaking）+ 有待播 → 排队（不播、不清）", () => {
    expect(sceneFallbackDecision("thinking", true).play).toBe(false);
    expect(sceneFallbackDecision("speaking", true).play).toBe(false);
  });

  it("isQuietPhase 只认 idle / listening", () => {
    expect(isQuietPhase("idle")).toBe(true);
    expect(isQuietPhase("listening")).toBe(true);
    expect(isQuietPhase("thinking")).toBe(false);
    expect(isQuietPhase("speaking")).toBe(false);
    expect(isQuietPhase("error")).toBe(false);
  });
});
