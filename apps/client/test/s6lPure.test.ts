import { describe, expect, it } from "vitest";
import { progressDots, storyNodeIndex, STORY_NODES } from "../src/live/storyProgress";
import { nextGuide, MAX_VISIBLE_GUIDES } from "../src/live/guides";
import { tapIntent } from "../src/live/interaction";

const GUIDES = ["主播还没下播？", "今天是不是不太开心", "这么晚还不睡吗"] as const;
const [G0, G1] = GUIDES;

describe("S6l §2 storyProgress", () => {
  it("节点顺序与下标", () => {
    expect(STORY_NODES).toEqual(["arrive", "probe", "reveal", "ending"]);
    expect(storyNodeIndex("arrive")).toBe(0);
    expect(storyNodeIndex("ending")).toBe(3);
  });

  it("4 个进度点：当前高亮，之前的 done，之后的 todo", () => {
    expect(progressDots("arrive")).toEqual(["current", "todo", "todo", "todo"]);
    expect(progressDots("probe")).toEqual(["done", "current", "todo", "todo"]);
    expect(progressDots("ending")).toEqual(["done", "done", "done", "current"]);
  });
});

describe("S6l §3 nextGuide", () => {
  it("按顺序取第一条未用过、未显示的", () => {
    expect(nextGuide({ guides: GUIDES, usedGuides: [], visibleGuides: [] })).toBe(G0);
    expect(nextGuide({ guides: GUIDES, usedGuides: [G0], visibleGuides: [] })).toBe(G1);
  });

  it("已显示的（仍在页面上的）不重复选", () => {
    expect(nextGuide({ guides: GUIDES, usedGuides: [], visibleGuides: [G0] })).toBe(G1);
  });

  it("都用过 → null", () => {
    expect(nextGuide({ guides: GUIDES, usedGuides: GUIDES, visibleGuides: [] })).toBeNull();
  });

  it("空候选 → null（ending）", () => {
    expect(nextGuide({ guides: [], usedGuides: [], visibleGuides: [] })).toBeNull();
  });

  it("同时最多显示 3 条（常量）", () => {
    expect(MAX_VISIBLE_GUIDES).toBe(3);
  });
});

describe("S6l §5/§6 tapIntent 全矩阵", () => {
  it("speaking：无论是否命中角色都是 interrupt", () => {
    expect(tapIntent("speaking", true)).toBe("interrupt");
    expect(tapIntent("speaking", false)).toBe("interrupt");
  });

  it("idle/listening 且命中角色 → poke", () => {
    expect(tapIntent("idle", true)).toBe("poke");
    expect(tapIntent("listening", true)).toBe("poke");
  });

  it("idle/listening 未命中角色 → none", () => {
    expect(tapIntent("idle", false)).toBe("none");
    expect(tapIntent("listening", false)).toBe("none");
  });

  it("thinking / error → none（不打断、不戳）", () => {
    expect(tapIntent("thinking", true)).toBe("none");
    expect(tapIntent("thinking", false)).toBe("none");
    expect(tapIntent("error", true)).toBe("none");
  });
});
