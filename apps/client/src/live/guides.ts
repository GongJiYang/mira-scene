/**
 * S6l §3：观众弹幕引导（纯函数）。
 *
 * 节奏（由外壳负责计时）：用户和角色都安静（idle）约 8 秒刷 1 条当前节点未用过的引导；
 * 同时最多显示 3 条；点过的不再出现；切节点后旧节点引导失效。
 *
 * 本模块只负责「选哪一条」，不碰计时、不碰 UI。
 */

/** 同时最多显示的引导条数（与 §3 一致）。 */
export const MAX_VISIBLE_GUIDES = 3;

export type NextGuideInput = {
  /** 当前节点的候选引导（顺序即优先级）。 */
  guides: readonly string[];
  /** 本节点已经用过的引导（点过 / 出现过）。 */
  usedGuides: readonly string[];
  /** 当前正显示在弹幕区的引导。 */
  visibleGuides: readonly string[];
};

/**
 * 选下一条引导：按顺序取第一条「未用过、未显示」的；都没有则 null。
 * 纯函数：同样输入必得同样输出。
 */
export function nextGuide(input: NextGuideInput): string | null {
  const used = new Set(input.usedGuides);
  const visible = new Set(input.visibleGuides);
  for (const guide of input.guides) {
    if (!used.has(guide) && !visible.has(guide)) return guide;
  }
  return null;
}

/**
 * 便捷入口：给定节点 + 角色包的 guides 表 + 本节点已用集合 + 当前显示集合。
 * 找不到候选（例如 ending）返回 null。
 */
export function nextGuideFor(
  node: keyof GuidesByNode,
  guides: GuidesByNode,
  usedGuides: readonly string[],
  visibleGuides: readonly string[],
): string | null {
  return nextGuide({ guides: guides[node] ?? [], usedGuides, visibleGuides });
}

export type GuidesByNode = Partial<Record<string, readonly string[]>>;
