/**
 * §1：剧情保底推进（纯函数）。
 *
 * 背景：推进完全依赖 LLM 自觉。即使 `advanceRule` 已「允许进入 X」，LLM 也可能一直不输出
 * `advance`，导致真实模式几乎看不到 probe → reveal → ending。
 *
 * 规则：
 * - 规则允许进入下一节点（`allowed` 非空）后，若本轮 LLM 仍未推进，计一次「已允许未推进」；
 * - **连续 2 个真实用户轮**（只数 `source === "user"`，不数 nudge / poke / gift）仍未推进，
 *   则服务端在本轮第一个 beat 上强制推进到 `allowed`；
 * - `ask_core` / `comfort` 意图命中时**当轮**就强制；
 * - 推进（LLM 或强制）后计数清零。
 *
 * 纯函数：不依赖时钟 / I/O；由会话层持有计数并回写 `nextStalled`。
 */
import type { StoryNode } from "@mira/protocol";

/** 触发保底推进所需「连续真实用户轮未推进」的次数。 */
export const FORCED_AFTER_STALLED_USER_TURNS = 2;

export type ForcedAdvanceInput = {
  /** `advanceRule` 允许进入的下一节点（不允许 / 终点时为 null）。 */
  allowed: StoryNode | null;
  /** 本轮 LLM 是否已提出并推进（`directorCtx.advancedThisTurn`）。 */
  advancedThisTurn: boolean;
  /** 本会话「连续真实用户轮未推进」计数（推进后清零）。 */
  stalledUserTurns: number;
  /** 本轮输入是否真实用户（`source === "user"`）。 */
  isRealUserTurn: boolean;
  /** 本轮意图是否命中当轮强制（`ask_core` / `comfort`）。 */
  forceNow: boolean;
};

export type ForcedAdvanceDecision = { force: StoryNode | null; nextStalled: number };

/** 纯函数：判定本轮是否强制推进，以及新的「已允许未推进」计数。 */
export function forcedAdvance(input: ForcedAdvanceInput): ForcedAdvanceDecision {
  // 未允许推进（含终点）：无可强制，计数清零。
  if (input.allowed === null) return { force: null, nextStalled: 0 };
  // 本轮已推进（LLM 自己走的）：无需强制，计数清零。
  if (input.advancedThisTurn) return { force: null, nextStalled: 0 };
  // 当轮强制：ask_core / comfort 命中允许条件时立刻推进。
  if (input.forceNow) return { force: input.allowed, nextStalled: 0 };

  // 只数真实用户轮；nudge / poke / gift 不推进计数也不清零。
  const nextStalled = input.isRealUserTurn ? input.stalledUserTurns + 1 : input.stalledUserTurns;
  if (nextStalled >= FORCED_AFTER_STALLED_USER_TURNS) return { force: input.allowed, nextStalled: 0 };
  return { force: null, nextStalled };
}
