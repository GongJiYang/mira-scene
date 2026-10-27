import { describe, expect, it } from "vitest";
import type { Emotion } from "@mira/protocol";
import { normalizeVoiceText, VOICE_KEY_LENGTH, voiceKey } from "../src/adapters/mock/voiceKey";

describe("normalizeVoiceText（S5 §1）", () => {
  it("去首尾空白、压中间空白", () => {
    expect(normalizeVoiceText("  你好  世界  ")).toBe("你好 世界");
  });

  it("全角标点/字母/数字统一成半角（NFKC）", () => {
    expect(normalizeVoiceText("你好，世界！")).toBe("你好,世界!");
    expect(normalizeVoiceText("ＡＢＣ１２３")).toBe("ABC123");
  });

  it("空串规整后仍为空串", () => {
    expect(normalizeVoiceText("   ")).toBe("");
  });
});

describe("voiceKey（S5 §1）", () => {
  it("同一句台词 + 同一情绪 → 同一个键（稳定）", () => {
    expect(voiceKey("雨还在下。", "calm")).toBe(voiceKey("雨还在下。", "calm"));
  });

  it("规整后才参与哈希：页边空白、全半角标点不影响键", () => {
    expect(voiceKey("  雨还在下。  ", "calm")).toBe(voiceKey("雨还在下.", "calm"));
  });

  it("情绪不同 → 键不同", () => {
    expect(voiceKey("雨还在下。", "calm")).not.toBe(voiceKey("雨还在下。", "sad"));
  });

  it("台词不同 → 键不同", () => {
    expect(voiceKey("雨还在下。", "calm")).not.toBe(voiceKey("雨停了。", "calm"));
  });

  it("键是定长的十六进制字符串（文件名友好）", () => {
    const key = voiceKey("雨还在下。", "calm");
    expect(key).toHaveLength(VOICE_KEY_LENGTH);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it("覆盖所有情绪枚举都不抛错", () => {
    const emotions: Emotion[] = ["neutral", "calm", "guarded", "sad", "warm", "surprised"];
    for (const emotion of emotions) {
      expect(voiceKey("嗯。", emotion)).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
