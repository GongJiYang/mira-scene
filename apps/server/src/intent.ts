/**
 * 关键词意图识别（s3-fix §4）：从 `adapters/mock/mockLlm.ts` 挪到这里，
 * 因为核心模块（提示词渲染、剧情推进判定）不能依赖 Mock 适配器。
 *
 * Mock 剧本与提示词都从这里 import；规则本身未变（沿用 mock 的关键词表）。
 */

export type Intent = "ask_waiting" | "ask_photo" | "ask_radio" | "comfort" | "greeting" | "other";

const INTENT_PATTERNS: ReadonlyArray<readonly [Intent, RegExp]> = [
  ["ask_waiting", /等|谁|为什么|约/],
  ["ask_photo", /照片|拍立得|相机|拍/],
  ["ask_radio", /电台|节目|主持|声音/],
  ["comfort", /没事|陪|别担心/],
  ["greeting", /你好|嗨/],
];

export function classifyIntent(text: string): Intent {
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(text)) return intent;
  }
  return "other";
}
