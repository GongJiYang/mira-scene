import { describe, expect, it } from "vitest";
import {
  FALLBACK_MOUTH_INTERVAL_MS,
  MOUTH_LEVEL_CONFIG,
  fallbackMouth,
  levelToMouth,
  mouthFor,
} from "../src/state/mouth";

describe("mouthFor：音频世界与表演世界之间的闸门", () => {
  it("speaking 且音频在播放 → 用传入的形状", () => {
    expect(mouthFor("speaking", true, "open")).toBe("open");
    expect(mouthFor("speaking", true, "small")).toBe("small");
    expect(mouthFor("speaking", true, "closed")).toBe("closed");
  });

  it("音频没在播放 → 一律 closed", () => {
    expect(mouthFor("speaking", false, "open")).toBe("closed");
    expect(mouthFor("speaking", false, "small")).toBe("closed");
  });

  it("非 speaking 状态 → 一律 closed（即使音频在播放）", () => {
    for (const phase of ["idle", "listening", "thinking", "error"] as const) {
      expect(mouthFor(phase, true, "open")).toBe("closed");
    }
  });
});

describe("levelToMouth：平滑 + 滞回", () => {
  it("静音停在 closed，平滑值为 0", () => {
    const result = levelToMouth(0, 0, 16);
    expect(result.shape).toBe("closed");
    expect(result.smoothed).toBe(0);
  });

  it("时间足够长时收敛到当前音量对应的形状", () => {
    expect(levelToMouth(0.5, 0, 1_000).shape).toBe("open");
    expect(levelToMouth(0.05, 0, 1_000).shape).toBe("small");
    expect(levelToMouth(0.005, 0, 1_000).shape).toBe("closed");
  });

  it("起音比释放快（30ms vs 80ms）", () => {
    const rising = levelToMouth(0.5, 0, 30).smoothed;
    const falling = levelToMouth(0, 0.5, 30).smoothed;
    // 同样 30ms：上升的变化量大于下降的变化量（释放更慢）。
    expect(rising).toBeGreaterThan(0.25);
    expect(0.5 - falling).toBeLessThan(rising);
  });

  it("滞回：从 closed 进入 small 需要超过 closedMax + hysteresis（0.03）", () => {
    expect(levelToMouth(0.025, 0, 1_000).shape).toBe("closed");
    expect(levelToMouth(0.035, 0, 1_000).shape).toBe("small");
  });

  it("滞回：从 small 回到 closed 需要低于 closedMax - hysteresis（0.01）", () => {
    // prev=0.05（small 区）时，0.025 仍留在 small，不因越过 0.02 就跳回 closed。
    expect(levelToMouth(0.025, 0.05, 1_000).shape).toBe("small");
    expect(levelToMouth(0.005, 0.05, 1_000).shape).toBe("closed");
  });

  it("滞回：small ↔ open 的边界同样带滞回（0.09 / 0.07）", () => {
    expect(levelToMouth(0.085, 0.05, 1_000).shape).toBe("small");
    expect(levelToMouth(0.095, 0.05, 1_000).shape).toBe("open");
    expect(levelToMouth(0.075, 0.5, 1_000).shape).toBe("open");
    expect(levelToMouth(0.065, 0.5, 1_000).shape).toBe("small");
  });

  it("越界音量被夹到 [0, 1]", () => {
    expect(levelToMouth(-1, 0, 1_000).smoothed).toBe(0);
    expect(levelToMouth(5, 1, 1_000).smoothed).toBe(1);
  });

  it("dtMs <= 0 时不推进平滑（保持上一帧的值）", () => {
    const result = levelToMouth(0.5, 0.2, 0);
    expect(result.smoothed).toBe(0.2);
  });

  it("阈值来自配置（说明改动只需改这一处）", () => {
    expect(MOUTH_LEVEL_CONFIG.closedMax).toBe(0.02);
    expect(MOUTH_LEVEL_CONFIG.smallMax).toBe(0.08);
  });
});

describe("fallbackMouth：拿不到 AnalyserNode 时的退路", () => {
  it("每 120ms 在 small / open 之间交替", () => {
    expect(fallbackMouth(0)).toBe("small");
    expect(fallbackMouth(FALLBACK_MOUTH_INTERVAL_MS - 1)).toBe("small");
    expect(fallbackMouth(FALLBACK_MOUTH_INTERVAL_MS)).toBe("open");
    expect(fallbackMouth(FALLBACK_MOUTH_INTERVAL_MS * 2)).toBe("small");
  });
});
