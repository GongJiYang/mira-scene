import { describe, expect, it } from "vitest";
import { isTurnIdAcceptable } from "../src";

describe("isTurnIdAcceptable", () => {
  it("相等时拒绝", () => {
    expect(isTurnIdAcceptable(7, 7)).toBe(false);
  });

  it("更小时拒绝", () => {
    expect(isTurnIdAcceptable(7, 6)).toBe(false);
    expect(isTurnIdAcceptable(7, 0)).toBe(false);
  });

  it("更大时接受", () => {
    expect(isTurnIdAcceptable(7, 8)).toBe(true);
    expect(isTurnIdAcceptable(0, 1)).toBe(true);
  });
});
