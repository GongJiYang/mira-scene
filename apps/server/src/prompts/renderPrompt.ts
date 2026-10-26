/**
 * 提示词渲染（架构关卡 §3 要求写成纯函数）：把静态前缀模板 + 动态后缀模板 + 上下文
 * 渲染成一组 chat 消息。不做 I/O，同样输入必得同样输出。
 *
 * 结构（D18）：STATIC 逐字不变作为 system；DYNAMIC 填充后作为最后一条 user。
 * 动态内容绝不能进前缀，否则命中不了 DeepSeek 的前缀缓存。
 */
import type { SceneState, StoryNode } from "@mira/protocol";
import { classifyIntent, type Intent } from "../intent";
import type { LLMHistoryEntry } from "../ports";
import { advanceRule } from "./advanceRule";

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type PromptContext = {
  scene: SceneState;
  history: readonly LLMHistoryEntry[];
  userText: string;
};

/** `user_text` 的上限（§2）：最长 500 字。 */
export const MAX_USER_TEXT_CHARS = 500;
/** `history` 保留的最近条数（§2）。 */
export const HISTORY_LIMIT = 12;

const NODE_LABEL: Record<StoryNode, string> = {
  arrive: "初遇",
  probe: "试探",
  reveal: "坦白",
  ending: "余韵",
};

const NODE_GUIDANCE: Record<StoryNode, string> = {
  arrive: "礼貌而疏离，可以主动招呼对方坐下，注意到窗外和那杯咖啡。",
  probe: "被问起时回避，但留下线索，例如「有人说过今晚会来」。",
  reveal: "可以讲出三年的信和今晚的约定。",
  ending: "回应对方今晚的陪伴，说出余韵。",
};

const COFFEE_PATTERN = /咖啡|那杯/;

/** 去掉尖括号（避免把用户输入当成标签），并截断到上限（§2 前置条件）。 */
export function sanitizeUserText(text: string): string {
  return text.replace(/[<>]/g, "").slice(0, MAX_USER_TEXT_CHARS);
}

/** 复用 mock 的意图识别；额外把「问那杯咖啡」当作直接问起（§2 的示例）。 */
export function promptIntent(text: string): Intent {
  if (COFFEE_PATTERN.test(text)) return "ask_waiting";
  return classifyIntent(text);
}

/** 关心次数：历史里（含本轮）属于关心类意图的条数（§2 的 trust 规则）。 */
export function countCare(history: readonly LLMHistoryEntry[], userText: string): number {
  let count = 0;
  for (const entry of history) {
    if (entry.role === "user" && classifyIntent(entry.text) === "comfort") count += 1;
  }
  if (classifyIntent(userText) === "comfort") count += 1;
  return count;
}

function renderHistory(history: readonly LLMHistoryEntry[]): string {
  const recent = history.slice(-HISTORY_LIMIT);
  if (recent.length === 0) return "（暂无）";
  return recent.map((entry) => `${entry.role === "user" ? "客人" : "凛"}：${entry.text}`).join("\n");
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (whole, key: string) => values[key] ?? whole);
}

export function renderPrompt(
  staticText: string,
  dynamicTemplate: string,
  ctx: PromptContext,
): ChatMessage[] {
  const userText = sanitizeUserText(ctx.userText);
  const care = countCare(ctx.history, ctx.userText);
  const intent = promptIntent(ctx.userText);
  const rule = advanceRule({ ...ctx.scene, trust: care }, intent, ctx.scene.turnCount);

  const dynamic = fillTemplate(dynamicTemplate, {
    node_label: NODE_LABEL[ctx.scene.node],
    node_guidance: NODE_GUIDANCE[ctx.scene.node],
    advance_rule: rule,
    turn_count: String(ctx.scene.turnCount),
    trust: String(care),
    scene_notes: "",
    history: renderHistory(ctx.history),
    user_text: userText,
  });

  return [
    { role: "system", content: staticText },
    { role: "user", content: dynamic },
  ];
}
