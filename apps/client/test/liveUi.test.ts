import { describe, expect, it } from "vitest";
import {
  danmakuOpacity,
  danmakuReducer,
  initialDanmakuState,
  MAX_MOBILE_DANMAKU,
  visibleDanmaku,
} from "../src/live/danmaku";
import {
  cycleChannel,
  DESKTOP_MIN_WIDTH,
  pickLayout,
  SWIPE_DISTANCE_PX,
  SWIPE_VELOCITY,
  swipeDecision,
} from "../src/live/layout";

/**
 * S6b §4：直播间 UI 的三个纯函数。
 * 组件本身不写单测（项目没有 RTL），行为由 e2e 覆盖。
 */

describe("danmakuReducer：追加、最多条数、淡出顺序", () => {
  it("追加：id 递增，kind / text 保留", () => {
    let state = danmakuReducer(initialDanmakuState, { type: "APPEND", kind: "user", text: "你好" });
    state = danmakuReducer(state, { type: "APPEND", kind: "transcript", text: "语音转写" });

    expect(state.items).toEqual([
      { id: 1, kind: "user", text: "你好", nickname: null },
      { id: 2, kind: "transcript", text: "语音转写", nickname: null },
    ]);
    expect(state.nextId).toBe(3);
  });

  it("空文本（含纯空白）不追加", () => {
    const state = danmakuReducer(initialDanmakuState, { type: "APPEND", kind: "user", text: "   " });
    expect(state.items).toEqual([]);
    expect(state.nextId).toBe(1);
  });

  it("超过上限时从最旧的一端丢弃（新的保留）", () => {
    let state = initialDanmakuState;
    for (let index = 1; index <= 8; index += 1) {
      state = danmakuReducer(state, { type: "APPEND", kind: "user", text: `第${index}条`, max: 6 });
    }
    expect(state.items).toHaveLength(6);
    expect(state.items[0]?.text).toBe("第3条");
    expect(state.items.at(-1)?.text).toBe("第8条");
  });

  it("CLEAR 清空列表但保留 id 计数（避免 React key 复用）", () => {
    let state = danmakuReducer(initialDanmakuState, { type: "APPEND", kind: "user", text: "一" });
    state = danmakuReducer(state, { type: "CLEAR" });
    expect(state.items).toEqual([]);
    expect(state.nextId).toBe(2);
  });

  it("手机浮层最多 6 条，新的在下（数组末尾）", () => {
    let state = initialDanmakuState;
    for (let index = 1; index <= 10; index += 1) {
      state = danmakuReducer(state, { type: "APPEND", kind: "user", text: `第${index}条` });
    }
    const visible = visibleDanmaku(state.items);
    expect(visible).toHaveLength(MAX_MOBILE_DANMAKU);
    expect(visible.at(-1)?.text).toBe("第10条");
    expect(visible[0]?.text).toBe("第5条");
  });

  it("淡出顺序：越旧越淡，最新完全不透明", () => {
    expect(danmakuOpacity(0, 6)).toBeLessThan(danmakuOpacity(5, 6));
    expect(danmakuOpacity(5, 6)).toBe(1);
    expect(danmakuOpacity(0, 1)).toBe(1);
    expect(danmakuOpacity(0, 0)).toBe(0);
  });
});

describe("pickLayout：900px 断点", () => {
  it("宽 ≥ 900 → 桌面；否则手机", () => {
    expect(DESKTOP_MIN_WIDTH).toBe(900);
    expect(pickLayout(1440)).toBe("desktop");
    expect(pickLayout(900)).toBe("desktop");
    expect(pickLayout(899)).toBe("mobile");
    expect(pickLayout(390)).toBe("mobile");
  });
});

describe("swipeDecision：阈值约 80px 或速度足够", () => {
  it("位移不足且速度不够 → 不切换", () => {
    expect(swipeDecision(10, 0.1)).toBeNull();
    expect(swipeDecision(-10, -0.1)).toBeNull();
    expect(swipeDecision(0, 0)).toBeNull();
  });

  it("向上滑超过阈值 → 下一个主播", () => {
    expect(swipeDecision(-SWIPE_DISTANCE_PX, -0.1)).toBe("next");
    expect(swipeDecision(-200, -0.2)).toBe("next");
  });

  it("向下滑超过阈值 → 上一个主播", () => {
    expect(swipeDecision(SWIPE_DISTANCE_PX, 0.1)).toBe("prev");
    expect(swipeDecision(200, 0.2)).toBe("prev");
  });

  it("位移不足但速度足够（快速轻扫）→ 切换", () => {
    expect(swipeDecision(-20, -SWIPE_VELOCITY)).toBe("next");
    expect(swipeDecision(20, SWIPE_VELOCITY)).toBe("prev");
  });

  it("速度与位移方向相反 → 不切换（避免回弹误触）", () => {
    expect(swipeDecision(-20, 0.9)).toBeNull();
    expect(swipeDecision(20, -0.9)).toBeNull();
  });

  it("非有限值 → 不切换", () => {
    expect(swipeDecision(Number.NaN, 1)).toBeNull();
    expect(swipeDecision(100, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("cycleChannel：循环切换", () => {
  const channels = ["rin", "yuna"];

  it("next / prev 循环", () => {
    expect(cycleChannel(channels, "rin", "next")).toBe("yuna");
    expect(cycleChannel(channels, "yuna", "next")).toBe("rin");
    expect(cycleChannel(channels, "rin", "prev")).toBe("yuna");
    expect(cycleChannel(channels, "yuna", "prev")).toBe("rin");
  });

  it("空列表返回原值", () => {
    expect(cycleChannel([], "rin", "next")).toBe("rin");
  });
});
