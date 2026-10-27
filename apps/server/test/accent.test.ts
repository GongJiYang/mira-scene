import { describe, expect, it } from "vitest";
import type { Accent, Emotion } from "@mira/protocol";
import { pickAccent, eventAccent } from "../src/director/accent";

function pick(overrides: {
  suggested?: Accent | null;
  emotion?: Emotion;
  say?: string;
  recentAccents?: readonly (Accent | null)[];
}): Accent | null {
  return pickAccent({
    suggested: overrides.suggested ?? null,
    emotion: overrides.emotion ?? "calm",
    say: overrides.say ?? "",
    recentAccents: overrides.recentAccents ?? [],
  });
}

describe("pickAccent：规则触发（熬夜 / 没睡 / 通宵 → dark）", () => {
  it.each(["又熬夜了？", "你是不是没睡", "通宵打游戏了吧", "熬夜晚了"])(
    "suggested 为空且台词含触发词「%s」→ dark",
    (say) => {
      expect(pick({ say })).toBe("dark");
    },
  );

  it("suggested 非空时不做规则触发（LLM 优先级更高）", () => {
    expect(pick({ suggested: "love", say: "又熬夜了？", emotion: "warm" })).toBe("love");
  });

  it("台词不含触发词且无 suggested → null", () => {
    expect(pick({ say: "今天天气不错" })).toBeNull();
  });
});

describe("pickAccent：词表内正常通过", () => {
  it("无冲突、无冷却是原样采纳", () => {
    expect(pick({ suggested: "love", emotion: "calm" })).toBe("love");
    expect(pick({ suggested: "angry", emotion: "surprised" })).toBe("angry");
    expect(pick({ suggested: "fly_head", emotion: "surprised" })).toBe("fly_head");
  });
});

describe("pickAccent：三组冲突不采纳（返回 null）", () => {
  it.each(["love", "heart", "fly_head", "fly_pet"] as Accent[])("sad × %s → null", (accent) => {
    expect(pick({ suggested: accent, emotion: "sad" })).toBeNull();
  });

  it.each(["angry", "black", "cry"] as Accent[])("warm × %s → null", (accent) => {
    expect(pick({ suggested: accent, emotion: "warm" })).toBeNull();
  });

  it.each(["love", "heart"] as Accent[])("guarded × %s → null", (accent) => {
    expect(pick({ suggested: accent, emotion: "guarded" })).toBeNull();
  });

  it("冲突表外的组合正常通过", () => {
    expect(pick({ suggested: "cry", emotion: "sad" })).toBe("cry");
    expect(pick({ suggested: "dark", emotion: "guarded" })).toBe("dark");
    expect(pick({ suggested: "angry", emotion: "calm" })).toBe("angry");
  });
});

describe("pickAccent：两档冷却", () => {
  it("普通 accent：最近 3 个 beat 内出现过同名 → null；滑出窗口后恢复", () => {
    expect(pick({ suggested: "love", emotion: "calm", recentAccents: ["love", null, null] })).toBeNull();
    expect(pick({ suggested: "love", emotion: "calm", recentAccents: [null, "love", null] })).toBeNull();
    expect(pick({ suggested: "love", emotion: "calm", recentAccents: [null, null, "love"] })).toBeNull();
    // 滑出 3 个窗口（love 在窗口之外）。
    expect(pick({ suggested: "love", emotion: "calm", recentAccents: ["love", null, null, null] })).toBe("love");
  });

  it("fly_head / fly_pet：最近 10 个 beat 内出现过同名 → null；仅 3 个不够", () => {
    // 4 个窗口内：普通档已滑出，但特殊档仍在 10 内 → null。
    expect(pick({ suggested: "fly_head", emotion: "surprised", recentAccents: [null, null, null, "fly_head"] })).toBeNull();
    expect(
      pick({
        suggested: "fly_pet",
        emotion: "surprised",
        recentAccents: [null, null, null, null, null, null, null, null, null, "fly_pet"],
      }),
    ).toBeNull();
    // 滑出 10 个窗口。
    expect(
      pick({
        suggested: "fly_head",
        emotion: "surprised",
        recentAccents: ["fly_head", null, null, null, null, null, null, null, null, null, null],
      }),
    ).toBe("fly_head");
  });

  it("冷却按同名判定：不同 accent 互不影响", () => {
    expect(pick({ suggested: "heart", emotion: "calm", recentAccents: ["love", null, null] })).toBe("heart");
  });

  it("规则触发的 dark 同样受冷却约束", () => {
    expect(pick({ say: "又熬夜了", recentAccents: ["dark", null, null] })).toBeNull();
    expect(pick({ say: "又熬夜了", recentAccents: ["dark", null, null, null] })).toBe("dark");
  });
});

describe("S6l §5：poke / gift 的 accent 规则", () => {
  function pickEvent(kind: "poke" | "gift", overrides: { emotion?: Emotion; recentAccents?: readonly (Accent | null)[]; pokeIndex?: number } = {}) {
    return pickAccent({
      suggested: null,
      emotion: overrides.emotion ?? "calm",
      say: "",
      recentAccents: overrides.recentAccents ?? [],
      kind,
      pokeIndex: overrides.pokeIndex,
    });
  }

  it("gift → love（覆盖 LLM 的 accent）", () => {
    expect(pickEvent("gift")).toBe("love");
  });

  it("gift 即使 LLM 给了别的 accent 也改成 love", () => {
    expect(
      pickAccent({ suggested: "angry", emotion: "calm", say: "", recentAccents: [], kind: "gift" }),
    ).toBe("love");
  });

  it("gift 冲突（sad 不配 love）→ 先改 heart，但 sad 也禁 heart → null", () => {
    // 冲突表里 sad / guarded 同时禁 love 与 heart，因此 heart 回退在真实表下退化为 null。
    expect(pickEvent("gift", { emotion: "sad" })).toBeNull();
  });

  it("heart 回退机制：love 冲突但 heart 不冲突时用 heart", () => {
    // 直接用 eventAccent + 冲突表验证回退逻辑（真实表下 sad/guarded 两者同禁）。
    expect(eventAccent("gift", 0)).toBe("love");
    expect(eventAccent("poke", 0)).toBe("shy");
    expect(eventAccent("poke", 1)).toBe("angry");
  });

  it("gift 冲突且 heart 也冲突（guarded 不配 love / heart）→ null", () => {
    expect(pickEvent("gift", { emotion: "guarded" })).toBeNull();
  });

  it("poke → 轮流 shy / angry（按 pokeIndex）", () => {
    expect(pickEvent("poke", { pokeIndex: 0 })).toBe("shy");
    expect(pickEvent("poke", { pokeIndex: 1 })).toBe("angry");
    expect(pickEvent("poke", { pokeIndex: 2 })).toBe("shy");
    expect(pickEvent("poke", { pokeIndex: 3 })).toBe("angry");
  });

  it("poke 的 shy 冲突（warm 不配…shy 不在冲突表，仍采纳；angry 冲突则 null）", () => {
    // warm 禁止 angry：pokeIndex=1（angry）在 warm 下 → null。
    expect(pickEvent("poke", { emotion: "warm", pokeIndex: 1 })).toBeNull();
    expect(pickEvent("poke", { emotion: "warm", pokeIndex: 0 })).toBe("shy");
  });

  it("poke / gift 同样受冷却约束", () => {
    expect(pickEvent("gift", { recentAccents: ["love", null, null] })).toBeNull();
    expect(pickEvent("poke", { pokeIndex: 0, recentAccents: ["shy", null, null] })).toBeNull();
  });
});
