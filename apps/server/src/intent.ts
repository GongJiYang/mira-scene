/**
 * 关键词意图识别（s3-fix §4；S6b §1 改成按角色关键词表）。
 *
 * 每个角色在 `characters/<id>/content.json` 的 `intents` 里给自己的关键词；
 * 本模块只提供纯函数 `classifyIntent(text, patterns)`，不依赖任何具体角色。
 *
 * 意图槽位（S6b §1）：`ask_core` / `ask_item` / `ask_job` / `comfort` / `greeting` / `other`。
 */
import type { IntentSlot } from "./characters/pack";

export type Intent = IntentSlot;

/** 「其他」兜底槽位。 */
export const OTHER_INTENT: Intent = "other";

/**
 * 按顺序匹配关键词表，第一个命中的意图胜出；都不中则 `other`。
 * 纯函数：同样的文本与关键词表必得同样结果。
 */
export function classifyIntent(text: string, patterns: ReadonlyArray<readonly [Intent, RegExp]>): Intent {
  for (const [intent, pattern] of patterns) {
    if (pattern.test(text)) return intent;
  }
  return OTHER_INTENT;
}
