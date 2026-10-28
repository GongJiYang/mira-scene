/**
 * §5.1：顶栏开播时长格式化（纯函数 formatHms）。
 */
import { describe, expect, it } from "vitest";
import { formatHms } from "../src/live/uiText";

describe("§5.1 formatHms：HH:MM:SS", () => {
  it("零与负值显示 00:00:00", () => {
    expect(formatHms(0)).toBe("00:00:00");
    expect(formatHms(-1000)).toBe("00:00:00");
    expect(formatHms(Number.NaN)).toBe("00:00:00");
  });

  it("秒 / 分 / 时逐级进位，各段两位补零", () => {
    expect(formatHms(1000)).toBe("00:00:01");
    expect(formatHms(61_000)).toBe("00:01:01");
    expect(formatHms(2 * 3600_000 + 14 * 60_000 + 37_000)).toBe("02:14:37");
    expect(formatHms(9_000)).toBe("00:00:09");
  });

  it("超过 99 小时仍正常（不截断）", () => {
    expect(formatHms(100 * 3600_000)).toBe("100:00:00");
  });

  it("不足一秒的部分向下取整", () => {
    expect(formatHms(1999)).toBe("00:00:01");
  });
});
