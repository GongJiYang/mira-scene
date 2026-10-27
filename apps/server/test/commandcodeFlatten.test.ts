import { describe, expect, it } from "vitest";
import { CMD_PROMPT_PREFIX, flattenMessages } from "../src/adapters/commandcode/flattenMessages";
import type { ChatMessage } from "../src/prompts/renderPrompt";

describe("flattenMessages（S6a §2）", () => {
  it("开头写明身份与「不调工具、只按格式输出」", () => {
    const out = flattenMessages([{ role: "system", content: "人设" }]);
    expect(out.startsWith(CMD_PROMPT_PREFIX)).toBe(true);
    expect(out).toContain("不调用任何工具");
  });

  it("每段标出角色，按顺序拼接", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: "U" },
      { role: "assistant", content: "A" },
    ];
    const out = flattenMessages(messages);
    expect(out).toContain("【系统】\nS");
    expect(out).toContain("【用户】\nU");
    expect(out).toContain("【助手】\nA");
    expect(out.indexOf("【系统】")).toBeLessThan(out.indexOf("【用户】"));
    expect(out.indexOf("【用户】")).toBeLessThan(out.indexOf("【助手】"));
  });

  it("空消息列表也能返回前缀", () => {
    expect(flattenMessages([])).toBe(CMD_PROMPT_PREFIX + "\n\n");
  });
});
