import { describe, expect, it } from "vitest";
import { DEFAULT_COMMANDCODE_MODEL, loadConfig } from "../src/config";
import { isCommandCodeAuthed, stripAnsi } from "../src/adapters/commandcode/status";

describe("config：LLM_PROVIDER（S6a §2）", () => {
  it("默认 deepseek，保持现有行为", () => {
    expect(loadConfig({}).llmProvider).toBe("deepseek");
  });

  it("commandcode 可选，并带默认模型", () => {
    const config = loadConfig({ LLM_PROVIDER: "commandcode" });
    expect(config.llmProvider).toBe("commandcode");
    expect(config.commandCodeModel).toBe(DEFAULT_COMMANDCODE_MODEL);
  });

  it("COMMANDCODE_MODEL 可覆盖", () => {
    expect(loadConfig({ LLM_PROVIDER: "commandcode", COMMANDCODE_MODEL: "x/y" }).commandCodeModel).toBe("x/y");
  });

  it("非法 LLM_PROVIDER 直接抛错", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "openai" })).toThrow(/LLM_PROVIDER/);
  });
});

describe("status：cmd status 输出的纯解析（S6a §2）", () => {
  it("去掉 ANSI 颜色码", () => {
    expect(stripAnsi("\u001b[32m✔\u001b[39m Authentication verified")).toBe("✔ Authentication verified");
  });

  it("已登录判定", () => {
    expect(isCommandCodeAuthed("✔ Authentication verified\n✔ Authenticated as alice")).toBe(true);
  });

  it("未登录判定", () => {
    expect(isCommandCodeAuthed("Not authenticated")).toBe(false);
    expect(isCommandCodeAuthed("请先登录")).toBe(false);
  });
});
