/**
 * 提示词渲染（架构关卡 §3 要求写成纯函数）：把静态前缀模板 + 动态后缀模板 + 上下文
 * 渲染成一组 chat 消息。不做 I/O，同样输入必得同样输出。
 *
 * 结构（D18）：STATIC 逐字不变作为 system；DYNAMIC 填充后作为最后一条 user。
 * 动态内容绝不能进前缀，否则命中不了前缀缓存。
 *
 * S6b §1：节点 label/guidance、意图关键词、历史里发言人名字都改为按角色包取。
 */
import type { SceneState } from "@mira/protocol";
import type { Pack } from "../characters/pack";
import { classifyIntent, type Intent } from "../intent";
import type { LLMHistoryEntry } from "../ports";
import { advanceRule } from "./advanceRule";

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type PromptContext = {
  scene: SceneState;
  history: readonly LLMHistoryEntry[];
  userText: string;
  /** D32：主动开口轮。动态后缀据此刻追加一句「对方沉默了一会儿」的提示。 */
  nudge?: boolean;
  /**
   * S6c §1：本轮弹幕命中「换背景」时，追加到 `scene_notes` 的提示
   * （「对方想换个背景，你这边正在换」）。角色照常回话，扩写与生图在后台进行。
   */
  sceneNotes?: string;
};

/** D32：主动开口轮追加到动态后缀的场景提示。 */
export const NUDGE_SCENE_NOTE = "对方沉默了一会儿，你可以自然地做点什么，或者轻声说一句。";

/** `user_text` 的上限（§2）：最长 500 字。 */
export const MAX_USER_TEXT_CHARS = 500;
/** `history` 保留的最近条数（§2）。 */
export const HISTORY_LIMIT = 12;

/** 历史里用户的固定称谓（各角色通用）。 */
const USER_LABEL = "客人";

/**
 * 夏凛的「那杯咖啡」在提示词里算作温和地直接问起（§2 的示例）。
 * 这是提示词渲染层的补充规则，不改变角色包的关键词表。
 */
const COFFEE_PATTERN = /咖啡|那杯/;

/** 渲染提示词所需的最小角色信息（便于单测传入轻量对象）。 */
export type PromptPack = Pick<
  Pack,
  "nodes" | "intentPatterns" | "displayName" | "staticText" | "dynamicTemplate" | "promptVersion"
>;

/** 去掉尖括号（避免把用户输入当成标签），并截断到上限（§2 前置条件）。 */
export function sanitizeUserText(text: string): string {
  return text.replace(/[<>]/g, "").slice(0, MAX_USER_TEXT_CHARS);
}

/** 关心次数：历史里（含本轮）属于 comfort 意图的条数（§2 的 trust 规则）。 */
export function countCare(pack: PromptPack, history: readonly LLMHistoryEntry[], userText: string): number {
  let count = 0;
  for (const entry of history) {
    if (entry.role === "user" && classifyIntent(entry.text, pack.intentPatterns) === "comfort") count += 1;
  }
  if (classifyIntent(userText, pack.intentPatterns) === "comfort") count += 1;
  return count;
}

function renderHistory(pack: PromptPack, history: readonly LLMHistoryEntry[]): string {
  const recent = history.slice(-HISTORY_LIMIT);
  if (recent.length === 0) return "（暂无）";
  return recent
    .map((entry) => `${entry.role === "user" ? USER_LABEL : pack.displayName}：${entry.text}`)
    .join("\n");
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (whole, key: string) => values[key] ?? whole);
}

export function renderPrompt(pack: PromptPack, ctx: PromptContext): ChatMessage[] {
  const userText = sanitizeUserText(ctx.userText);
  const care = countCare(pack, ctx.history, ctx.userText);
  // 复用角色包的关键词表；额外把「问那杯咖啡」当作直接问起（§2 的示例）。
  const intent: Intent = COFFEE_PATTERN.test(ctx.userText)
    ? "ask_core"
    : classifyIntent(ctx.userText, pack.intentPatterns);
  // S6l §1：arrive → probe 需要「用户说过至少 1 轮」，与 Mock 的 `priorUserTurns >= 1` 一致
  // （只看历史里的用户轮数，不含本轮）。
  // S6l-fix2 §7：只数真实用户（source === "user"）；主动开口 / poke / gift 的占位不算用户说过话。
  const userTurns = ctx.history.filter(
    (entry) => entry.role === "user" && (entry.source ?? "user") === "user",
  ).length;
  const rule = advanceRule({ ...ctx.scene, trust: care }, intent, ctx.scene.turnCount, userTurns);
  const node = pack.nodes[ctx.scene.node];
  // S6l §4：沉默时按阶段抛钩子——nudge 轮把当前节点的 hook 提示给 LLM（无 hook 时用原提示）。
  const nudgeNote = ctx.nudge
    ? node.hook !== ""
      ? `${NUDGE_SCENE_NOTE}（可以顺着这个念头开口：「${node.hook}」）`
      : NUDGE_SCENE_NOTE
    : "";

  const dynamic = fillTemplate(pack.dynamicTemplate, {
    node_label: node.label,
    node_guidance: node.guidance,
    advance_rule: rule,
    turn_count: String(ctx.scene.turnCount),
    trust: String(care),
    // S6c §1：nudge 与 sceneNotes 可叠加（弹幕命中换背景时，角色照常回话并知道正在换背景）。
    scene_notes: [nudgeNote, ctx.sceneNotes ?? ""].filter(Boolean).join(""),
    history: renderHistory(pack, ctx.history),
    user_text: userText,
  });

  return [
    { role: "system", content: pack.staticText },
    { role: "user", content: dynamic },
  ];
}
