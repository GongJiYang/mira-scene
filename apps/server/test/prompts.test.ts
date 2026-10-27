import { describe, expect, it } from "vitest";
import type { LLMHistoryEntry } from "../src/ports";
import { ADVANCE_ALLOW_ENDING, ADVANCE_ALLOW_REVEAL, ADVANCE_HOLD, advanceRule } from "../src/prompts/advanceRule";
import { loadPromptTemplate, parsePromptFile, PROMPT_FILE } from "../src/prompts/loader";
import { renderPrompt, sanitizeUserText, type PromptPack } from "../src/prompts/renderPrompt";
import { createInitialScene } from "../src/story";
import { testPack } from "./helpers/pack";

const STATIC = "静态前缀·逐字不变";
const DYNAMIC = [
  "当前阶段：{{node_label}}",
  "{{node_guidance}}",
  "{{advance_rule}}",
  "轮次={{turn_count}} 关心={{trust}} 备注={{scene_notes}}",
  "记录：",
  "{{history}}",
  "<用户>{{user_text}}</用户>",
].join("\n");

/** 用一个轻量 pack（复用真实忧奈的节点/意图，替换静态与动态模板）。 */
const base = testPack("yuna");
const pack: PromptPack = { ...base, staticText: STATIC, dynamicTemplate: DYNAMIC };

function ctx(overrides: Partial<{ scene: ReturnType<typeof createInitialScene>; history: LLMHistoryEntry[]; userText: string }> = {}) {
  return {
    scene: createInitialScene(),
    history: [] as LLMHistoryEntry[],
    userText: "你好",
    ...overrides,
  };
}

describe("advanceRule（§2 的三种条件）", () => {
  const arrive = createInitialScene();

  it("trust（关心次数）≥2 → 允许进入 reveal", () => {
    expect(advanceRule({ ...arrive, trust: 2 }, "other", 0)).toBe(ADVANCE_ALLOW_REVEAL);
    expect(advanceRule({ ...arrive, trust: 1 }, "other", 0)).toBe(ADVANCE_HOLD);
  });

  it("用户温和地直接问起 → 允许进入 reveal", () => {
    expect(advanceRule(arrive, "ask_core", 0)).toBe(ADVANCE_ALLOW_REVEAL);
  });

  it("turn_count≥8 → 允许进入 reveal；其余情况不要推进", () => {
    expect(advanceRule(arrive, "greeting", 8)).toBe(ADVANCE_ALLOW_REVEAL);
    expect(advanceRule(arrive, "greeting", 7)).toBe(ADVANCE_HOLD);
  });

  it("进入 reveal 两轮之后才允许 ending；没有 revealTurn → 不允许推进", () => {
    expect(advanceRule({ ...arrive, node: "reveal", revealTurn: 2 }, "other", 4)).toBe(ADVANCE_ALLOW_ENDING);
    expect(advanceRule({ ...arrive, node: "reveal", revealTurn: 2 }, "other", 3)).toBe(ADVANCE_HOLD);
    expect(advanceRule({ ...arrive, node: "reveal" }, "other", 99)).toBe(ADVANCE_HOLD);
    expect(advanceRule({ ...arrive, node: "ending" }, "ask_core", 12)).toBe(ADVANCE_HOLD);
  });

  it("s3-fix §2：第 8 轮进入 reveal → 第 9 轮不允许、第 10 轮允许", () => {
    const scene = { ...arrive, node: "reveal" as const, revealTurn: 8 };
    expect(advanceRule(scene, "other", 9)).toBe(ADVANCE_HOLD);
    expect(advanceRule(scene, "other", 10)).toBe(ADVANCE_ALLOW_ENDING);
  });
});

describe("renderPrompt", () => {
  it("STATIC 逐字不变作为 system；跨轮完全相同", () => {
    const first = renderPrompt(pack, ctx({ userText: "你好" }));
    const second = renderPrompt(pack, ctx({ userText: "你在等谁？" }));
    expect(first[0]).toEqual({ role: "system", content: STATIC });
    expect(second[0]).toEqual(first[0]);
    expect(first[1]?.role).toBe("user");
  });

  it("user_text 去掉尖括号", () => {
    const messages = renderPrompt(pack, ctx({ userText: "<script>你好</script>" }));
    const user = messages[1]?.content ?? "";
    expect(user).toContain("script你好/script");
    expect(user).not.toContain("<script>");
  });

  it("user_text 截断到 500 字", () => {
    expect(sanitizeUserText("雨".repeat(600))).toHaveLength(500);
  });

  it("node_label / node_guidance 按剧情节点切换", () => {
    const arrive = renderPrompt(pack, ctx());
    const reveal = renderPrompt(pack, ctx({ scene: { ...createInitialScene(), node: "reveal" } }));
    expect(arrive[1]?.content).toContain("下播之后");
    expect(arrive[1]?.content).toContain("她以为直播间没人了");
    expect(reveal[1]?.content).toContain("老截图");
    expect(reveal[1]?.content).toContain("第一次开播的截图");
  });

  it("history 用「客人：/忧奈：」格式，最多保留最近 12 条", () => {
    const history: LLMHistoryEntry[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: `第${index}句`,
    }));
    const messages = renderPrompt(pack, ctx({ history }));
    const user = messages[1]?.content ?? "";
    expect(user).toContain("客人：第8句");
    expect(user).toContain("忧奈：第9句");
    expect(user).not.toContain("第0句");
  });

  it("关心次数写进 {{trust}}，并驱动 advance_rule", () => {
    const history: LLMHistoryEntry[] = [
      { role: "user", text: "我陪你坐一会儿" },
      { role: "assistant", text: "谢谢" },
      { role: "user", text: "别担心" },
    ];
    const messages = renderPrompt(pack, ctx({ history }));
    const user = messages[1]?.content ?? "";
    expect(user).toContain("关心=2");
    expect(user).toContain(ADVANCE_ALLOW_REVEAL);
  });

  it("问那杯咖啡也算温和地直接问起", () => {
    const messages = renderPrompt(pack, ctx({ userText: "那杯咖啡，是给他点的吧？" }));
    expect(messages[1]?.content).toContain(ADVANCE_ALLOW_REVEAL);
  });
});

describe("loader", () => {
  it("解析 version 与 STATIC / DYNAMIC 段落", () => {
    const text = "<!-- prompt: rin.v9 · 2026-01-01 -->\n\n## STATIC\n系统\n\n## DYNAMIC\n动态 {{user_text}}\n";
    const parsed = parsePromptFile(text, "mem");
    expect(parsed.version).toBe("rin.v9");
    expect(parsed.staticText).toBe("系统");
    expect(parsed.dynamicTemplate).toBe("动态 {{user_text}}");
  });

  it("从仓库读取 yuna.v1.md", () => {
    const template = loadPromptTemplate();
    expect(template.source).toContain(PROMPT_FILE);
    expect(template.version).toBe("yuna.v1");
    expect(template.staticText).toContain("忧奈");
    expect(template.dynamicTemplate).toContain("{{node_label}}");
  });
});
