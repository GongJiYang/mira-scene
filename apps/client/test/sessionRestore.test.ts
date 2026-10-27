/**
 * S6l-fix1 §2：刷新恢复的客户端逻辑测试。
 *
 * - 收到带 background 的 session 消息 → 背景 URL 正确（直接切换，不播生成中状态与动画）；
 * - 收到 transcript → role:"user" 的条目恢复进弹幕（显示为「你」发的，样式同平时），不重复；
 *   assistant 条目不进弹幕。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { danmakuReducer, initialDanmakuState } from "../src/live/danmaku";
import { useSceneStatusStore } from "../src/live/scene/status";
import { applySessionRestore, useSessionRestoreStore } from "../src/live/sessionRestore";

beforeEach(() => {
  useSceneStatusStore.setState({ display: { kind: "idle" }, backgroundUrl: null, direct: false });
  useSessionRestoreStore.setState({ userLines: [] });
});

describe("恢复背景（S6l-fix1 §2）", () => {
  it("带 background → 直接切到该背景，且标记 direct（不播生成中状态 / 动画）", () => {
    applySessionRestore({
      background: { label: "黄昏海边", urls: { desktop: "/generated/a-desktop.png", mobile: "/generated/a-mobile.png" } },
      transcript: [],
    });
    const state = useSceneStatusStore.getState();
    expect(state.backgroundUrl).toEqual({ desktop: "/generated/a-desktop.png", mobile: "/generated/a-mobile.png" });
    // 不显示「生成中」状态条。
    expect(state.display.kind).toBe("idle");
    // 直接切换标记（Live 据此跳过交叉淡入）。
    expect(state.direct).toBe(true);
  });

  it("background 为 null → 保持默认背景（backgroundUrl 仍为 null）", () => {
    applySessionRestore({ background: null, transcript: [] });
    expect(useSceneStatusStore.getState().backgroundUrl).toBeNull();
  });
});

describe("恢复用户弹幕（S6l-fix1 §2）", () => {
  it("只恢复 user 条目，assistant 不进弹幕", () => {
    applySessionRestore({
      background: null,
      transcript: [
        { role: "user", text: "你好" },
        { role: "assistant", text: "嗯。\n也在。" },
        { role: "user", text: "在吗" },
      ],
    });
    expect(useSessionRestoreStore.getState().userLines).toEqual(["你好", "在吗"]);
  });

  it("reducer：RESTORE_USER 按顺序追加 user 弹幕，不重复添加", () => {
    let state = danmakuReducer(initialDanmakuState, { type: "RESTORE_USER", texts: ["你好", "在吗"] });
    expect(state.items.map((item) => item.text)).toEqual(["你好", "在吗"]);
    expect(state.items.every((item) => item.kind === "user")).toBe(true);

    // 再次恢复同一批 → 不重复。
    state = danmakuReducer(state, { type: "RESTORE_USER", texts: ["你好", "在吗"] });
    expect(state.items.map((item) => item.text)).toEqual(["你好", "在吗"]);

    // 恢复历史里已有的一条 + 一条新的 → 只补缺失的。
    state = danmakuReducer(state, { type: "RESTORE_USER", texts: ["在吗", "新的一条"] });
    expect(state.items.map((item) => item.text)).toEqual(["你好", "在吗", "新的一条"]);
  });

  it("reducer：RESTORE_USER 与已有用户弹幕去重，但保留 guide / transcript", () => {
    let state = danmakuReducer(initialDanmakuState, { type: "APPEND", kind: "guide", text: "主播还没下播？" });
    state = danmakuReducer(state, { type: "APPEND", kind: "user", text: "你好" });
    state = danmakuReducer(state, { type: "RESTORE_USER", texts: ["你好", "新的一条"] });
    expect(state.items.map((item) => item.text)).toEqual(["主播还没下播？", "你好", "新的一条"]);
    expect(state.items[0]?.kind).toBe("guide");
  });
});
