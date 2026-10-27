import { describe, expect, it } from "vitest";
import { DEVELOP_MS, developProgress } from "../src/stage/develop";

describe("developProgress（§6）", () => {
  it("0 → 0，3s → 1，且被夹在 0–1", () => {
    expect(developProgress(0)).toBe(0);
    expect(developProgress(-500)).toBe(0);
    expect(developProgress(DEVELOP_MS / 2)).toBeCloseTo(0.5);
    expect(developProgress(DEVELOP_MS)).toBe(1);
    expect(developProgress(DEVELOP_MS * 10)).toBe(1);
    expect(developProgress(Number.NaN)).toBe(0);
  });

  it("随时间单调不减", () => {
    let previous = -1;
    for (let t = -100; t <= DEVELOP_MS + 500; t += 100) {
      const value = developProgress(t);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
  });
});
