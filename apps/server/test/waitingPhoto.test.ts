import { describe, expect, it } from "vitest";
import { hasWaitingPhoto } from "../src/scene/waitingPhoto";

/**
 * freeze-fix3 §2/§4：未就绪照片判定（纯函数）。
 * 输入：会话已调度的剧情照片事件 与 已就绪 / 失败集合 → 是否还有「已调度、未就绪」的照片。
 */
describe("hasWaitingPhoto：未就绪照片判定（§2）", () => {
  it("有已调度、未就绪的照片：true", () => {
    expect(
      hasWaitingPhoto({
        scheduled: ["s:2:0"],
        ready: new Set(),
      }),
    ).toBe(true);
  });

  it("全部就绪：false", () => {
    expect(
      hasWaitingPhoto({
        scheduled: ["s:2:0", "s:3:1"],
        ready: new Set(["s:2:0", "s:3:1"]),
      }),
    ).toBe(false);
  });

  it("失败（走兜底）也算不再等待：false", () => {
    expect(
      hasWaitingPhoto({
        scheduled: ["s:2:0"],
        ready: new Set(["s:2:0"]),
        failed: new Set(["s:2:0"]),
      }),
    ).toBe(false);
  });

  it("部分就绪、部分未就绪：true", () => {
    expect(
      hasWaitingPhoto({
        scheduled: ["s:2:0", "s:3:1"],
        ready: new Set(["s:2:0"]),
      }),
    ).toBe(true);
  });

  it("没有调度过照片：false", () => {
    expect(hasWaitingPhoto({ scheduled: [], ready: new Set() })).toBe(false);
  });
});
