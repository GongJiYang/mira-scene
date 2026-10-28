/**
 * freeze-fix5 §3：无声 beat 的可读时长。
 *
 * - `silentBeatMs` 纯函数：按可读速度（中文约 220ms/字）计算，标点 / 空白不计，
 *   下限 1_500ms、上限 6_000ms。
 * - 无声 beat 调度：用现有时间线外壳断言结束时刻 = `silentBeatMs(say)`。
 */
import { describe, expect, it } from "vitest";
import { createTimeline } from "../src/core/timeline";
import { SILENT_BEAT_MAX_MS, SILENT_BEAT_MIN_MS, silentBeatMs } from "../src/core/scheduler";

describe("silentBeatMs：无声 beat 可读时长（freeze-fix5 §2.1）", () => {
  it("空串 / 纯标点 / 纯空白 → 取下限 1500ms", () => {
    expect(silentBeatMs("")).toBe(SILENT_BEAT_MIN_MS);
    expect(silentBeatMs("，。！？…——")).toBe(SILENT_BEAT_MIN_MS);
    expect(silentBeatMs("   \n\t ")).toBe(SILENT_BEAT_MIN_MS);
    expect(SILENT_BEAT_MIN_MS).toBe(1_500);
  });

  it("短句取下限", () => {
    // 5 字 × 220 = 1100 < 1500 → 夹到下限。
    expect(silentBeatMs("你好呀你好")).toBe(1_500);
  });

  it("中间线性：按每字 220ms 计算", () => {
    // 10 字 × 220 = 2200，落在 [1500, 6000] 内。
    expect(silentBeatMs("一二三四五六七八九十")).toBe(2_200);
    // 15 字 × 220 = 3300。
    expect(silentBeatMs("一二三四五六七八九十一二三四五")).toBe(3_300);
  });

  it("长句取上限 6000ms", () => {
    const long = "字".repeat(40); // 40 × 220 = 8800 > 6000 → 夹到上限。
    expect(silentBeatMs(long)).toBe(SILENT_BEAT_MAX_MS);
    expect(SILENT_BEAT_MAX_MS).toBe(6_000);
  });

  it("标点与空白不计入字数", () => {
    const withPunct = silentBeatMs("一二三四五，六七八九十。");
    const bare = silentBeatMs("一二三四五六七八九十");
    expect(withPunct).toBe(bare);
    expect(withPunct).toBe(2_200);

    const withSpaces = silentBeatMs("一 二 三 四 五 六 七 八 九 十");
    expect(withSpaces).toBe(bare);
  });

  it("随字数单调不减（契约：时长 ∈ [1500, 6000]）", () => {
    let previous = 0;
    for (let chars = 0; chars <= 40; chars += 1) {
      const value = silentBeatMs("字".repeat(chars));
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(SILENT_BEAT_MIN_MS);
      expect(value).toBeLessThanOrEqual(SILENT_BEAT_MAX_MS);
      previous = value;
    }
  });
});

describe("无声 beat 调度：结束时刻 = silentBeatMs(say)（freeze-fix5 §3）", () => {
  it("时间线在该 beat 停留 silentBeatMs(say) 后才结束", () => {
    let now = 1_000;
    let timerId = 0;
    const pending = new Map<number, () => void>();
    const timeline = createTimeline({
      now: () => now,
      setTimer: (callback) => {
        timerId += 1;
        pending.set(timerId, callback);
        return timerId;
      },
      clearTimer: (id) => {
        pending.delete(id);
      },
    });

    const say = "一二三四五六七八九十"; // silentBeatMs = 2_200
    const duration = silentBeatMs(say);
    let ended = false;
    timeline.schedule({
      key: `silent:1:0`,
      turnId: 1,
      atMs: timeline.now() + silentBeatMs(say),
      run: () => {
        ended = true;
      },
    });

    // 还差 1ms：未结束。
    now = 1_000 + duration - 1;
    for (const callback of [...pending.values()]) callback();
    expect(ended).toBe(false);

    // 正好到点：结束。
    now = 1_000 + duration;
    for (const callback of [...pending.values()]) callback();
    expect(ended).toBe(true);
  });
});
