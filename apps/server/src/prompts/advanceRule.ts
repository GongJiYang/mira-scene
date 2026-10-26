/**
 * 剧情推进判定（架构关卡 §3 要求写成纯函数）。
 *
 * 返回给提示词用的「advance_rule」文本，决定这一轮是否引导 LLM 提议推进剧情。
 * 最终是否推进仍由 `story.ts` 校验（D6），这里只影响提示词措辞。
 *
 * trust 语义：这里用的是「关心次数」（§2 的 trust 规则），不是 story 里的节点进度；
 * 调用方（`renderPrompt`）会把关心次数写进传入对象的 `trust` 字段。
 *
 * ending 判定（s3-fix §2）：必须「进入 reveal 两轮之后」才允许，
 * 用 `scene.revealTurn`（进入 reveal 时的轮次）计算；没有 revealTurn 时不允许 ending。
 */
import type { SceneState } from "@mira/protocol";
import type { Intent } from "../intent";

/** 「进入 reveal 两轮之后」允许 ending（s3-fix §2）。 */
export const REVEAL_TO_ENDING_AFTER_TURNS = 2;
/** 「turn_count≥8」的保底推进阈值（§2）。 */
export const REVEAL_AFTER_TURNS = 8;
/** 温和地直接问起即可推进的 trust 阈值（§2）。 */
export const REVEAL_AFTER_TRUST = 2;

export const ADVANCE_ALLOW_REVEAL = "允许进入 reveal";
export const ADVANCE_ALLOW_ENDING = "允许进入 ending";
export const ADVANCE_HOLD = "现在不要推进剧情";

export function advanceRule(scene: SceneState, intent: Intent, turnCount: number): string {
  if (scene.node === "ending") return ADVANCE_HOLD;
  if (scene.node === "reveal") {
    // 进入 reveal 两轮之后才允许 ending；没有 revealTurn 时不允许。
    const revealTurn = scene.revealTurn;
    if (revealTurn === undefined) return ADVANCE_HOLD;
    return turnCount - revealTurn >= REVEAL_TO_ENDING_AFTER_TURNS ? ADVANCE_ALLOW_ENDING : ADVANCE_HOLD;
  }
  // arrive / probe：trust≥2、被温和地直接问起，或聊够 8 轮 → 允许 reveal。
  const asksDirectly = intent === "ask_waiting";
  if (scene.trust >= REVEAL_AFTER_TRUST || asksDirectly || turnCount >= REVEAL_AFTER_TURNS) {
    return ADVANCE_ALLOW_REVEAL;
  }
  return ADVANCE_HOLD;
}
