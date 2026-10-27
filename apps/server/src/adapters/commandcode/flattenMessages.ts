/**
 * `flattenMessages`：把 `renderPrompt` 产出的 chat 消息拼成一条 prompt（S6a §2）。
 *
 * `cmd -p` 只接受一段文本，没有 system/user/assistant 角色，所以要把消息按角色标好拼起来，
 * 并在最前面写明「你不是编程助手，不调用任何工具，只按下面的格式输出」。
 *
 * 纯函数：不做 I/O、不读时钟、不抛错。
 */
import type { ChatMessage } from "../../prompts/renderPrompt";

/** 前缀（逐字不变）：明确身份与「只用台词格式」的约束。 */
export const CMD_PROMPT_PREFIX =
  "你不是编程助手，不调用任何工具，不做代码解释。只按下面的格式输出。";

const ROLE_LABEL: Record<ChatMessage["role"], string> = {
  system: "系统",
  user: "用户",
  assistant: "助手",
};

/** 角色之间用空行分隔，便于模型区分段落。 */
export function flattenMessages(messages: readonly ChatMessage[]): string {
  const blocks = messages.map((message) => `【${ROLE_LABEL[message.role]}】\n${message.content}`);
  return `${CMD_PROMPT_PREFIX}\n\n${blocks.join("\n\n")}`;
}
