/**
 * 剧情推进判定（架构关卡 §3 要求写成纯函数）。
 *
 * 返回给提示词用的「advance_rule」文本，决定这一轮是否引导 LLM 提议推进剧情。
 * 最终是否推进仍由 `story.ts` 校验（D6），这里只影响提示词措辞。
 *
 * S6l §1：advance_rule 文本按节点生成，保证「允许进入 X」与 `NEXT_NODE[node]` 一致，
 * 不再出现「允许进入」与允许目标不一致的情况。
 *
 * trust 语义：这里用的是「关心次数」（§2 的 trust 规则），不是 story 里的节点进度；
 * 调用方（`renderPrompt`）会把关心次数写进传入对象的 `trust` 字段。
 *
 * ending 判定（s3-fix §2）：必须「进入 reveal 两轮之后」才允许，
 * 用 `scene.revealTurn`（进入 reveal 时的轮次）计算；没有 revealTurn 时不允许 ending。
 */
import type { SceneState, StoryNode } from "@mira/protocol";
import type { Intent } from "../intent";
import { nextStoryNode } from "../story";

/** 「进入 reveal 两轮之后」允许 ending（s3-fix §2）。 */
export const REVEAL_TO_ENDING_AFTER_TURNS = 2;
/** 「turn_count≥8」的保底推进阈值（§2）——probe → reveal。 */
export const REVEAL_AFTER_TURNS = 8;
/** 温和地直接问起即可推进的 trust 阈值（§2）——probe → reveal。 */
export const REVEAL_AFTER_TRUST = 2;
/** arrive → probe：用户说过至少 1 轮后（与 Mock 的 `priorUserTurns >= 1` 一致）。 */
export const PROBE_AFTER_USER_TURNS = 1;

export const ADVANCE_HOLD = "现在不要推进剧情";

/** 生成「允许进入 <node>」文本，只对存在的下一节点调用。 */
export function advanceAllowText(node: StoryNode): string {
  return `允许进入 ${node}`;
}

/** 便捷常量（文本与 NEXT_NODE 一致）。 */
export const ADVANCE_ALLOW_PROBE = advanceAllowText("probe");
export const ADVANCE_ALLOW_REVEAL = advanceAllowText("reveal");
export const ADVANCE_ALLOW_ENDING = advanceAllowText("ending");

/**
 * 纯函数：当前节点 + 意图 + 轮次 + 用户说话轮数 → advance_rule 文本。
 *
 * - arrive：用户说过至少 1 轮 → 允许进入 probe；否则不推进。
 * - probe：trust≥2、被温和地直接问起，或聊够 8 轮 → 允许进入 reveal。
 * - reveal：进入两轮之后 → 允许进入 ending。
 * - ending：总是 hold。
 *
 * 允许的目标恒等于 `NEXT_NODE[scene.node]`（由 `nextStoryNode` 提供）。
 * `userTurns` 是历史里用户侧的轮数（含本轮），由调用方传入。
 */
export function advanceRule(
  scene: SceneState,
  intent: Intent,
  turnCount: number,
  userTurns = 1,
): string {
  const next = nextStoryNode(scene.node);
  if (next === null) return ADVANCE_HOLD;

  switch (scene.node) {
    case "arrive":
      return userTurns >= PROBE_AFTER_USER_TURNS ? advanceAllowText(next) : ADVANCE_HOLD;
    case "probe": {
      const asksDirectly = intent === "ask_core";
      if (scene.trust >= REVEAL_AFTER_TRUST || asksDirectly || turnCount >= REVEAL_AFTER_TURNS) {
        return advanceAllowText(next);
      }
      return ADVANCE_HOLD;
    }
    case "reveal": {
      const revealTurn = scene.revealTurn;
      if (revealTurn === undefined) return ADVANCE_HOLD;
      return turnCount - revealTurn >= REVEAL_TO_ENDING_AFTER_TURNS ? advanceAllowText(next) : ADVANCE_HOLD;
    }
    case "ending":
      return ADVANCE_HOLD;
  }
}
