/**
 * S6b §5.5：真实生图提示词组装（纯函数）。
 *
 * 模板来自角色包 content.json 的 `imagePrompt`（原样使用，铁律 6），
 * 其中 `{{conversation}}` 占位符替换为**最近 3 轮对话**的摘要。
 * 历史条目按 `role: "user" | "assistant"` 排列，两轮（一问一答）算一轮。
 */
import type { Pack } from "../../characters/pack";
import type { LLMHistoryEntry } from "../../ports";

/** S6b-fix1 §4：每条对话截断 80 字（按码点计），避免提示词过长。 */
const MAX_ENTRY_CHARS = 80;

function truncate(text: string): string {
  const chars = [...text];
  return chars.length <= MAX_ENTRY_CHARS ? text : `${chars.slice(0, MAX_ENTRY_CHARS).join("")}…`;
}

/** 取最近 3 轮（最多 6 条：3 问 3 答）拼成一段摘要（每条截断 80 字）。 */
function summarize(history: readonly LLMHistoryEntry[]): string {
  const recent = history.slice(-6);
  return recent
    .map((entry) => (entry.role === "user" ? `观众：${truncate(entry.text)}` : `主播：${truncate(entry.text)}`))
    .join("\n");
}

/**
 * `buildImagePrompt(pack, history)`：把 pack.imagePrompt 的 `{{conversation}}`
 * 替换为最近 3 轮对话摘要。历史为空时用占位说明（不让模板留空）。
 */
export function buildImagePrompt(pack: Pack, history: readonly LLMHistoryEntry[]): string {
  const conversation = history.length === 0 ? "（还没有对话）" : summarize(history);
  return pack.imagePrompt.split("{{conversation}}").join(conversation);
}
