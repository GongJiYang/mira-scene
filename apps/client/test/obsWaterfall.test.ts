import { describe, expect, it } from "vitest";
import { turnTotalMs, waterfallScaleMs, type TurnTimeline } from "../src/obs/ObsApp";

function turn(overrides: Partial<TurnTimeline>): TurnTimeline {
  return {
    sessionId: "s1",
    turnId: 1,
    startedAt: 0,
    aborted: false,
    failed: false,
    ...overrides,
  };
}

describe("S6g-A §6：观测页瀑布条共用同一时间刻度", () => {
  it("turnTotalMs 取各阶段累计到的最大值", () => {
    expect(turnTotalMs(turn({ sttMs: 10, llmFirstBeatMs: 50, ttsFirstAudioMs: 80, endMs: 120 }))).toBe(120);
  });

  it("waterfallScaleMs 取全部行里最长的一轮（至少为 1）", () => {
    const turns = [
      turn({ turnId: 1, endMs: 200 }),
      turn({ turnId: 2, endMs: 900 }),
      turn({ turnId: 3, endMs: 400 }),
    ];
    expect(waterfallScaleMs(turns)).toBe(900);
  });

  it("空表 / 全 undefined 时退化为 1（避免除零）", () => {
    expect(waterfallScaleMs([])).toBe(1);
    expect(waterfallScaleMs([turn({})])).toBe(1);
  });
});
