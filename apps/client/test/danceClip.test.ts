import { describe, expect, it } from "vitest";
import { FIT_PRESETS, LIVE_FIT_PRESETS } from "../src/render/live2d/cubism/fit";
import { danceVideoRect, danceVideoSrc, modelBoundsRect } from "../src/render/live2d/danceClip";

// 配准实测几何：预览页画布 772×1888（desktop 预设），截图坐标 = 画布坐标 + (156, 16)。
// 原型里视频绘制在截图坐标 (16, 0, 1040×1913.6) → 画布坐标 (-140, -16)。
describe("跳舞片段与 Live2D 配准", () => {
  it("预览页几何下，模型包围盒投影与实测一致", () => {
    const b = modelBoundsRect(772, 1888, FIT_PRESETS.desktop);
    expect(b.left).toBeCloseTo(0, 0);
    expect(b.width).toBeCloseTo(772, 0);
    expect(b.top).toBeCloseTo(212.7, 0);
    expect(b.height).toBeCloseTo(1462.6, 0);
  });

  it("预览页几何下，视频矩形还原离线配准结果（误差 < 1px）", () => {
    const r = danceVideoRect(772, 1888, FIT_PRESETS.desktop);
    expect(Math.abs(r.left - -140)).toBeLessThan(1);
    expect(Math.abs(r.top - -16)).toBeLessThan(1);
    expect(Math.abs(r.width - 1040)).toBeLessThan(1);
    expect(Math.abs(r.height - 1913.6)).toBeLessThan(1);
  });

  it("视频宽高比恒等于素材宽高比，且随包围盒等比缩放", () => {
    for (const [w, h, preset] of [
      [1180, 860, LIVE_FIT_PRESETS.liveDesktop],
      [390, 748, LIVE_FIT_PRESETS.liveMobile],
      [430, 836, LIVE_FIT_PRESETS.liveMobile],
    ] as const) {
      const r = danceVideoRect(w, h, preset);
      const b = modelBoundsRect(w, h, preset);
      expect(r.width / r.height).toBeCloseTo(1040 / 1913.6, 3);
      expect(r.height / b.height).toBeCloseTo(1.30835, 4);
    }
  });

  it("Safari / iOS 用 HEVC 透明 mov，其余用 VP9 透明 webm", () => {
    const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    const iosChrome = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1";
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    expect(danceVideoSrc(safari)).toMatch(/\.mov$/);
    expect(danceVideoSrc(iosChrome)).toMatch(/\.mov$/);
    expect(danceVideoSrc(chrome)).toMatch(/\.webm$/);
  });
});
