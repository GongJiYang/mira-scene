/**
 * S6l-fix2 §1：舞台点击只认「空白处」。
 *
 * 手机端点任何东西都曾算「戳一下」（点输入框 / 引导弹幕 / 字幕 / 菜单 / 截图关闭钮都会发 poke）。
 * 修法：短按事件目标落在交互元素内（button / a / input / textarea / [role=button] /
 * [data-no-stage-tap]）时一律忽略；画布找不到时返回 false（不再当作命中角色）。
 *
 * 纯函数：只依赖 `closest()` 这一个 DOM 能力（用轻量替身即可单测，不需要真实 DOM）。
 */
import { describe, expect, it } from "vitest";
import { isStageTapTarget, resolveStageTap } from "../src/live/interaction";

/**
 * 轻量 DOM 替身：只实现 `closest`。
 * `chain` 是「自身 + 祖先」按由内到外的顺序匹配的选择器集合。
 */
/** 只记录元素本身匹配的「单个」选择器标签；`closest` 收到的逗号列表由替身拆分比对。 */
type Node = { tag: string } | null;

function fake(chain: Node[]): { closest(selector: string): unknown } {
  return {
    closest(selector) {
      const parts = selector.split(",").map((part) => part.trim().toLowerCase());
      return chain.find((node) => node !== null && parts.includes(node.tag.toLowerCase())) ?? null;
    },
  };
}

const TAG = (name: string): Node => ({ tag: name });

describe("isStageTapTarget：交互元素内不算舞台点击（S6l-fix2 §1）", () => {
  it("button / a / input / textarea / role=button 本身 → true", () => {
    for (const tag of ["button", "a", "input", "textarea", "[role=button]"]) {
      expect(isStageTapTarget(fake([TAG(tag)]))).toBe(true);
    }
  });

  it("嵌套在 button 内的 span → true（closest 向上查）", () => {
    // 自身是 span（不匹配），祖先是 button（匹配）。
    expect(isStageTapTarget(fake([TAG("span"), TAG("button")]))).toBe(true);
  });

  it("data-no-stage-tap 容器及其后代 → true", () => {
    const container = TAG("[data-no-stage-tap]");
    expect(isStageTapTarget(fake([container]))).toBe(true);
    expect(isStageTapTarget(fake([TAG("span"), container]))).toBe(true);
  });

  it("普通舞台元素 / null / 无 closest → false", () => {
    expect(isStageTapTarget(fake([TAG("div")]))).toBe(false);
    expect(isStageTapTarget(fake([null]))).toBe(false);
    expect(isStageTapTarget(null)).toBe(false);
    expect(isStageTapTarget(undefined)).toBe(false);
    expect(isStageTapTarget({})).toBe(false);
  });
});

describe("resolveStageTap：手机短按的完整判定（S6l-fix2 §1）", () => {
  // 输入框位置：目标是一个 input（命中角色竖条的坐标），但不应触发 poke。
  const input = fake([TAG("input")]);
  // 舞台空白处：普通 div。
  const blank = fake([TAG("div")]);

  it("点在输入框（即使坐标命中角色竖条）→ null，不发 poke", () => {
    expect(resolveStageTap("idle", input, true)).toBeNull();
    expect(resolveStageTap("listening", input, true)).toBeNull();
  });

  it("点在舞台空白处且坐标命中角色 → poke", () => {
    expect(resolveStageTap("idle", blank, true)).toBe("poke");
  });

  it("点在舞台空白处但未命中角色 → null", () => {
    expect(resolveStageTap("idle", blank, false)).toBeNull();
  });

  it("说话时点空白处（未命中角色）→ interrupt", () => {
    expect(resolveStageTap("speaking", blank, false)).toBe("interrupt");
  });

  it("点在交互元素内即使说话中也不打断 → null", () => {
    expect(resolveStageTap("speaking", input, true)).toBeNull();
  });
});
