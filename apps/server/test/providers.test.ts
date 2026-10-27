/**
 * S6n §1/§2 单测：Provider 工厂的纯函数核心。
 * - `resolveKeys`：访问者提供的 Key 优先，否则服务端 `.env`；
 * - `resolveMode` 规则矩阵（auto/mock/real × 各类 Key 有无 × 访问者/服务端来源）；
 * - `computeCapabilities`：只说明来源，不含 Key；
 * - `planSession`：真实模式缺关键 Key → `ok: false` 并点名缺哪一类。
 */
import { describe, expect, it } from "vitest";
import type { HelloKeys } from "@mira/protocol";
import type { ProviderCredentials } from "../src/config";
import { chooseKey, computeCapabilities, planSession, resolveKeys, resolveMode } from "../src/providers";

const EMPTY: ProviderCredentials = {
  deepseek: { apiKey: "", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  fish: { apiKey: "", baseUrl: "https://api.fish.audio/v1", voiceId: "", ttsModel: "s2.1-pro-free" },
  image: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "img" },
};

function serverWith(patch: Partial<ProviderCredentials>): ProviderCredentials {
  return { ...EMPTY, ...patch };
}

const userAll: HelloKeys = {
  deepseek: { apiKey: "sk-user-llm" },
  fish: { apiKey: "sk-user-voice" },
  image: { apiKey: "sk-user-img", baseUrl: "https://img.example/v1" },
};

describe("chooseKey：访问者优先，否则服务端", () => {
  it("访问者非空 → user 来源", () => {
    expect(chooseKey("sk-user", "sk-server")).toEqual({ value: "sk-user", source: "user" });
  });
  it("访问者空 → 服务端", () => {
    expect(chooseKey("", "sk-server")).toEqual({ value: "sk-server", source: "server" });
    expect(chooseKey("   ", "sk-server")).toEqual({ value: "sk-server", source: "server" });
  });
  it("两者都空 → none", () => {
    expect(chooseKey(undefined, "")).toEqual({ value: "", source: "none" });
  });
  it("访问者只给空白 → 视为未提供", () => {
    expect(chooseKey("   ", "sk-server")).toEqual({ value: "sk-server", source: "server" });
  });
});

describe("resolveKeys：三类 Key + 音色覆盖", () => {
  it("访问者全给 → 三类均 user", () => {
    const resolved = resolveKeys({ ...userAll, fish: { apiKey: "sk-user-voice", voiceId: " voice-x " } }, EMPTY);
    expect(resolved.deepseek).toEqual({ value: "sk-user-llm", source: "user" });
    expect(resolved.fish).toEqual({ value: "sk-user-voice", source: "user" });
    expect(resolved.image.source).toBe("user");
    expect(resolved.image.baseUrl).toBe("https://img.example/v1");
    expect(resolved.fishVoiceIdUser).toBe("voice-x");
  });
  it("访问者不给 → 服务端来源", () => {
    const server = serverWith({
      deepseek: { apiKey: "sk-server-llm", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
      fish: { apiKey: "sk-server-voice", baseUrl: "https://api.fish.audio/v1", voiceId: "", ttsModel: "m" },
    });
    const resolved = resolveKeys(undefined, server);
    expect(resolved.deepseek.source).toBe("server");
    expect(resolved.fish.source).toBe("server");
    expect(resolved.image.source).toBe("none");
  });
  it("混合：LLM 访问者给、语音服务端给", () => {
    const server = serverWith({ fish: { apiKey: "sk-server-voice", baseUrl: "https://api.fish.audio/v1", voiceId: "", ttsModel: "m" } });
    const resolved = resolveKeys({ deepseek: { apiKey: "sk-user-llm" } }, server);
    expect(resolved.deepseek.source).toBe("user");
    expect(resolved.fish.source).toBe("server");
  });
});

describe("resolveMode：规则矩阵", () => {
  const none = resolveKeys(undefined, EMPTY);
  const llmOnlyUser = resolveKeys({ deepseek: { apiKey: "sk-user-llm" } }, EMPTY);
  const voiceOnlyUser = resolveKeys({ fish: { apiKey: "sk-user-voice" } }, EMPTY);
  const bothUser = resolveKeys(userAll, EMPTY);
  const bothServer = resolveKeys(undefined, serverWith({
    deepseek: { apiKey: "s", baseUrl: "b", model: "m" },
    fish: { apiKey: "s", baseUrl: "b", voiceId: "", ttsModel: "m" },
  }));

  it("mock：始终 mock，不读 Key", () => {
    expect(resolveMode("mock", bothUser)).toEqual({ mode: "mock", missing: [] });
    expect(resolveMode("mock", none)).toEqual({ mode: "mock", missing: [] });
  });

  it("auto：LLM 与语音都有 Key → real", () => {
    expect(resolveMode("auto", bothUser).mode).toBe("real");
    expect(resolveMode("auto", bothServer).mode).toBe("real");
  });

  it("auto：缺任一类 → mock", () => {
    expect(resolveMode("auto", none).mode).toBe("mock");
    expect(resolveMode("auto", llmOnlyUser).mode).toBe("mock");
    expect(resolveMode("auto", voiceOnlyUser).mode).toBe("mock");
  });

  it("real：有 Key → real；缺 Key → real + missing（交给上层报错）", () => {
    expect(resolveMode("real", bothUser)).toEqual({ mode: "real", missing: [] });
    expect(resolveMode("real", none)).toEqual({ mode: "real", missing: ["llm", "voice"] });
    expect(resolveMode("real", llmOnlyUser)).toEqual({ mode: "real", missing: ["voice"] });
    expect(resolveMode("real", voiceOnlyUser)).toEqual({ mode: "real", missing: ["llm"] });
  });

  it("auto 模式下访问者补齐服务端缺的那一类 → real", () => {
    const serverLlmOnly = resolveKeys(undefined, serverWith({ deepseek: { apiKey: "s", baseUrl: "b", model: "m" } }));
    const mixed = resolveKeys({ fish: { apiKey: "sk-user-voice" } }, serverWith({ deepseek: { apiKey: "s", baseUrl: "b", model: "m" } }));
    expect(resolveMode("auto", serverLlmOnly).mode).toBe("mock");
    expect(resolveMode("auto", mixed).mode).toBe("real");
  });
});

describe("computeCapabilities：只说明来源，不含 Key", () => {
  it("mock：llm / voice 一律 none（不读 Key），image 仍报来源", () => {
    const resolved = resolveKeys(userAll, EMPTY);
    expect(computeCapabilities("mock", resolved)).toEqual({ llm: "none", voice: "none", image: "user" });
  });
  it("real：如实报三类来源", () => {
    const resolved = resolveKeys(userAll, EMPTY);
    expect(computeCapabilities("real", resolved)).toEqual({ llm: "user", voice: "user", image: "user" });
  });
});

describe("planSession：整合模式 + capabilities + 音色覆盖", () => {
  it("auto 且两类 Key 齐全 → real，capabilities 为来源", () => {
    const plan = planSession("auto", userAll, EMPTY);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.mode).toBe("real");
    expect(plan.capabilities).toEqual({ llm: "user", voice: "user", image: "user" });
  });

  it("显式 real 但缺两类 → ok:false 且 missing 点名", () => {
    const plan = planSession("real", undefined, EMPTY);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.missing).toEqual(["llm", "voice"]);
  });

  it("auto 缺 Key → mock（不报错）", () => {
    const plan = planSession("auto", undefined, EMPTY);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.mode).toBe("mock");
    expect(plan.capabilities).toEqual({ llm: "none", voice: "none", image: "none" });
  });

  it("音色覆盖透传到 voiceIdUser", () => {
    const plan = planSession("auto", { ...userAll, fish: { apiKey: "v", voiceId: "my-voice" } }, EMPTY);
    if (!plan.ok) throw new Error("应 ok");
    expect(plan.voiceIdUser).toBe("my-voice");
  });
});
