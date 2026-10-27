import { describe, expect, it } from "vitest";
import {
  BASE_RAIN_ALPHA,
  BASE_RAIN_COUNT,
  BASE_RAIN_SPEED,
  RAIN_STOP_FADE_MS,
  rainParams,
} from "../src/stage/rain";

describe("rainParams（§3）", () => {
  it("rain_heavy 满强度：数量/速度/透明度为基准值", () => {
    expect(rainParams("rain_heavy", 0)).toEqual({
      count: BASE_RAIN_COUNT,
      speed: BASE_RAIN_SPEED,
      alpha: BASE_RAIN_ALPHA,
    });
    expect(rainParams("rain_heavy", 99_999).count).toBe(BASE_RAIN_COUNT);
  });

  it("fx 为 null（会话开始前）按暴雨处理", () => {
    expect(rainParams(null, 0).count).toBe(BASE_RAIN_COUNT);
  });

  it("lights_dim 保持下雨；warm_glow 已经雨停", () => {
    expect(rainParams("lights_dim", 10_000).count).toBe(BASE_RAIN_COUNT);
    expect(rainParams("warm_glow", 0).count).toBe(0);
    expect(rainParams("warm_glow", 0).alpha).toBe(0);
  });

  it("rain_stop 在 4s 内线性渐停", () => {
    expect(rainParams("rain_stop", 0).count).toBe(BASE_RAIN_COUNT);
    expect(rainParams("rain_stop", RAIN_STOP_FADE_MS / 2).count).toBe(BASE_RAIN_COUNT / 2);
    expect(rainParams("rain_stop", RAIN_STOP_FADE_MS).count).toBe(0);
    expect(rainParams("rain_stop", RAIN_STOP_FADE_MS * 3).count).toBe(0);
  });

  it("count 与 alpha 随时间单调不增，且都非负", () => {
    let previousCount = Number.POSITIVE_INFINITY;
    let previousAlpha = Number.POSITIVE_INFINITY;
    for (let t = 0; t <= RAIN_STOP_FADE_MS + 2_000; t += 250) {
      const params = rainParams("rain_stop", t);
      expect(params.count).toBeGreaterThanOrEqual(0);
      expect(params.count).toBeLessThanOrEqual(previousCount);
      expect(params.alpha).toBeLessThanOrEqual(previousAlpha);
      previousCount = params.count;
      previousAlpha = params.alpha;
    }
  });

  it("减少动态效果时雨量减半", () => {
    expect(rainParams("rain_heavy", 0, true).count).toBe(Math.round(BASE_RAIN_COUNT * 0.5));
    expect(rainParams("rain_stop", RAIN_STOP_FADE_MS / 2, true).count).toBe(Math.round(BASE_RAIN_COUNT * 0.5 * 0.5));
  });

  it("边界：负数与极端值不越界", () => {
    expect(rainParams("rain_stop", -1_000).count).toBe(BASE_RAIN_COUNT);
    expect(rainParams("rain_stop", Number.NaN).alpha).toBe(0);
  });
});
