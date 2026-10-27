/**
 * S6n §5 单测：设置面板的纯函数。
 * - `resolveRequestedMode`：三选一 → hello 的 mode；
 * - `helloKeysFrom`：空字符串的 Key 不发送；三组都空 → undefined；
 * - `capabilityLabel`：来源 → 中文标签。
 * 不发任何网络请求（纯函数）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  capabilityLabel,
  helloKeysFrom,
  normalizeMode,
  resolveRequestedMode,
  SETTINGS_TEXT,
  type Settings,
} from "../src/live/settings";

const base: Settings = { ...DEFAULT_SETTINGS };

describe("resolveRequestedMode / normalizeMode", () => {
  it("三选一原样返回", () => {
    expect(resolveRequestedMode({ ...base, mode: "auto" })).toBe("auto");
    expect(resolveRequestedMode({ ...base, mode: "mock" })).toBe("mock");
    expect(resolveRequestedMode({ ...base, mode: "real" })).toBe("real");
  });
  it("非法值退回归 auto", () => {
    expect(normalizeMode("bogus")).toBe("auto");
    expect(normalizeMode(undefined)).toBe("auto");
    expect(normalizeMode(null)).toBe("auto");
  });
});

describe("helloKeysFrom：空字符串不发送", () => {
  it("全空 → undefined（不下发 keys 字段）", () => {
    expect(helloKeysFrom(base)).toBeUndefined();
  });

  it("只填聊天 → 只带 deepseek", () => {
    expect(helloKeysFrom({ ...base, deepseekKey: " sk-llm " })).toEqual({ deepseek: { apiKey: "sk-llm" } });
  });

  it("语音：带音色覆盖", () => {
    expect(helloKeysFrom({ ...base, fishKey: "sk-voice", fishVoiceId: "v1" })).toEqual({
      fish: { apiKey: "sk-voice", voiceId: "v1" },
    });
  });

  it("语音：不填音色 → 不带 voiceId", () => {
    expect(helloKeysFrom({ ...base, fishKey: "sk-voice" })).toEqual({ fish: { apiKey: "sk-voice" } });
  });

  it("生图：需 apiKey + baseUrl 同时有；缺 baseUrl 不发送该类", () => {
    expect(helloKeysFrom({ ...base, imageKey: "sk-img" })).toBeUndefined();
    expect(helloKeysFrom({ ...base, imageKey: "sk-img", imageBaseUrl: "https://img/v1" })).toEqual({
      image: { apiKey: "sk-img", baseUrl: "https://img/v1" },
    });
    expect(
      helloKeysFrom({ ...base, imageKey: "sk-img", imageBaseUrl: "https://img/v1", imageModel: "m" }),
    ).toEqual({ image: { apiKey: "sk-img", baseUrl: "https://img/v1", model: "m" } });
  });

  it("三组齐全 → 三个键都在", () => {
    const keys = helloKeysFrom({
      ...base,
      deepseekKey: "a",
      fishKey: "b",
      imageKey: "c",
      imageBaseUrl: "https://img/v1",
    });
    expect(Object.keys(keys ?? {}).sort()).toEqual(["deepseek", "fish", "image"]);
  });

  it("只填语音音色但不填 Key → 不发语音（音色无 Key 不单独发送）", () => {
    expect(helloKeysFrom({ ...base, fishVoiceId: "v" })).toBeUndefined();
  });
});

describe("capabilityLabel", () => {
  it("来源 → 中文标签", () => {
    expect(capabilityLabel("user")).toBe(SETTINGS_TEXT.sourceUser);
    expect(capabilityLabel("server")).toBe(SETTINGS_TEXT.sourceServer);
    expect(capabilityLabel("none")).toBe(SETTINGS_TEXT.sourceNone);
  });
});
