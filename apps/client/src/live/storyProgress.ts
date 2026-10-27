/**
 * S6l §2：剧情阶段可见（纯函数）。
 *
 * 顶部显示 `streamTitle` + 4 个进度点（当前节点高亮）。当前节点只认服务端下发的
 * `snapshot.node` / `beat.story.advance`（客户端不自己推断）。
 */
import type { StoryNode } from "@mira/protocol";

/** 剧情节点的固定顺序。 */
export const STORY_NODES: readonly StoryNode[] = ["arrive", "probe", "reveal", "ending"];

/** 当前节点的下标（0–3）；未知节点回退到 0。 */
export function storyNodeIndex(node: StoryNode): number {
  const index = STORY_NODES.indexOf(node);
  return index < 0 ? 0 : index;
}

/** 4 个进度点的状态：当前节点高亮（current），之前的节点为 done，之后的为 todo。 */
export type ProgressDotState = "done" | "current" | "todo";

export function progressDots(node: StoryNode): ProgressDotState[] {
  const current = storyNodeIndex(node);
  return STORY_NODES.map((_, index) => (index < current ? "done" : index === current ? "current" : "todo"));
}
