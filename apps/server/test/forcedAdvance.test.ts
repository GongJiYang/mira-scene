/**
 * §1：剧情保底推进（纯函数 forcedAdvance）单测。
 */
import { describe, expect, it } from "vitest";
import { forcedAdvance, FORCED_AFTER_STALLED_USER_TURNS } from "../src/director/forcedAdvance";

const base = {
  allowed: "reveal" as const,
  advancedThisTurn: false,
  stalledUserTurns: 0,
  isRealUserTurn: true,
  forceNow: false,
};

describe("§1 forcedAdvance：判定与计数", () => {
  it("allowed 为 null（终点 / 未允许）→ 不强制，计数清零", () => {
    expect(forcedAdvance({ ...base, allowed: null, stalledUserTurns: 5 })).toEqual({ force: null, nextStalled: 0 });
  });

  it("本轮 LLM 已推进 → 不强制，计数清零", () => {
    expect(forcedAdvance({ ...base, advancedThisTurn: true, stalledUserTurns: 5 })).toEqual({ force: null, nextStalled: 0 });
  });

  it("ask_core / comfort（forceNow）→ 当轮强制", () => {
    expect(forcedAdvance({ ...base, forceNow: true, stalledUserTurns: 0 })).toEqual({ force: "reveal", nextStalled: 0 });
  });

  it("第一个真实用户轮未推进：计数 +1，不强制", () => {
    expect(forcedAdvance({ ...base, stalledUserTurns: 0 })).toEqual({ force: null, nextStalled: 1 });
  });

  it("连续 2 个真实用户轮未推进 → 强制并清零", () => {
    expect(forcedAdvance({ ...base, stalledUserTurns: 1 })).toEqual({ force: "reveal", nextStalled: 0 });
    expect(FORCED_AFTER_STALLED_USER_TURNS).toBe(2);
  });

  it("非真实用户轮（nudge / poke / gift）不计入、也不清零", () => {
    expect(forcedAdvance({ ...base, isRealUserTurn: false, stalledUserTurns: 1 })).toEqual({ force: null, nextStalled: 1 });
    expect(forcedAdvance({ ...base, isRealUserTurn: false, stalledUserTurns: 0 })).toEqual({ force: null, nextStalled: 0 });
  });
});
