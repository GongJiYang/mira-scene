import { describe, expect, it } from "vitest";
import type { StoryNode } from "@mira/protocol";
import { classifyIntent, type Intent } from "../src/intent";
import { composeBeats, createMockLlm } from "../src/adapters/mock/mockLlm";
import type { LLMContext } from "../src/ports";
import { createInitialScene } from "../src/story";

const NODES: StoryNode[] = ["arrive", "probe", "reveal", "ending"];
const INTENTS: Intent[] = ["ask_waiting", "ask_photo", "ask_radio", "comfort", "greeting", "other"];

const TEXT_BY_INTENT: Record<Intent, string> = {
  ask_waiting: "你在等谁？",
  ask_photo: "能看看照片吗",
  ask_radio: "你主持的节目叫什么",
  comfort: "我陪你坐一会儿",
  greeting: "你好",
  other: "今天店里很安静",
};

const LLM_BEAT_KEYS = ["say", "emotion", "suggest", "advance"];

function context(overrides: Partial<LLMContext> = {}): LLMContext {
  return { history: [], scene: createInitialScene(), userText: "你好", ...overrides };
}

describe("mockLlm：意图与台词", () => {
  it("关键词意图识别", () => {
    expect(classifyIntent("你在等谁？")).toBe("ask_waiting");
    expect(classifyIntent("为什么还没来")).toBe("ask_waiting");
    expect(classifyIntent("他约的几点")).toBe("ask_waiting");
    expect(classifyIntent("能看看照片吗")).toBe("ask_photo");
    expect(classifyIntent("带拍立得了吗")).toBe("ask_photo");
    expect(classifyIntent("相机借我看看")).toBe("ask_photo");
    expect(classifyIntent("能拍一张吗")).toBe("ask_photo");
    expect(classifyIntent("你的电台节目几点开始")).toBe("ask_radio");
    expect(classifyIntent("声音很好听")).toBe("ask_radio");
    expect(classifyIntent("别担心")).toBe("comfort");
    expect(classifyIntent("我陪你")).toBe("comfort");
    expect(classifyIntent("你好")).toBe("greeting");
    expect(classifyIntent("嗨")).toBe("greeting");
    expect(classifyIntent("今天天气不错")).toBe("other");
  });

  it("每个节点 × 每种意图都有 2–3 个 beat，且至少一个 say 为空串", () => {
    for (const node of NODES) {
      for (const intent of INTENTS) {
        const beats = composeBeats(
          context({ scene: { ...createInitialScene(), node }, userText: TEXT_BY_INTENT[intent] }),
        );
        expect(beats.length).toBeGreaterThanOrEqual(2);
        expect(beats.length).toBeLessThanOrEqual(3);
        expect(beats.some((beat) => beat.say === "")).toBe(true);
        expect(beats.filter((beat) => beat.say !== "").every((beat) => beat.say.length > 0)).toBe(true);
      }
    }
  });

  it("只输出契约 ① 的字段（say / emotion / suggest / advance）", () => {
    for (const node of NODES) {
      for (const intent of INTENTS) {
        const beats = composeBeats(
          context({ scene: { ...createInitialScene(), node }, userText: TEXT_BY_INTENT[intent] }),
        );
        for (const beat of beats) {
          expect(Object.keys(beat).sort()).toEqual([...LLM_BEAT_KEYS].sort());
        }
      }
    }
  });

  it("arrive 下第 2 次输入起提议 probe；probe 下 ask_waiting/comfort 提议 reveal；reveal 下提议 ending", () => {
    const arrive = createInitialScene();
    const firstBeat = composeBeats(context({ scene: arrive, userText: "你好" }));
    expect(firstBeat.every((beat) => beat.advance === null)).toBe(true);

    const secondInput = composeBeats(
      context({ scene: arrive, userText: "你好", history: [{ role: "user", text: "你好" }, { role: "assistant", text: "你来了。" }] }),
    );
    expect(secondInput.at(-1)?.advance).toBe("probe");

    const probeScene = { ...createInitialScene(), node: "probe" as const };
    expect(composeBeats(context({ scene: probeScene, userText: "你在等谁？" })).at(-1)?.advance).toBe("reveal");
    expect(composeBeats(context({ scene: probeScene, userText: "别担心" })).at(-1)?.advance).toBe("reveal");
    expect(composeBeats(context({ scene: probeScene, userText: "你好" })).at(-1)?.advance ?? null).toBeNull();

    const revealScene = { ...createInitialScene(), node: "reveal" as const };
    expect(composeBeats(context({ scene: revealScene, userText: "然后呢" })).at(-1)?.advance).toBe("ending");

    const endingScene = { ...createInitialScene(), node: "ending" as const };
    expect(composeBeats(context({ scene: endingScene, userText: "你好" })).every((beat) => beat.advance === null)).toBe(true);
  });

  it("进入 reveal 的那一轮用 advance + suggest 表达意图（视觉由导演层给出）", () => {
    const probeScene = { ...createInitialScene(), node: "probe" as const };
    const beats = composeBeats(context({ scene: probeScene, userText: "你在等谁？" }));
    expect(beats.at(-1)).toMatchObject({ advance: "reveal", suggest: "show_polaroid", emotion: "sad" });
    expect(beats.every((beat) => !("camera" in beat) && !("fx" in beat) && !("media" in beat))).toBe(true);
  });

  it("至少一个 beat 提议 glance_window 的无声动作（say 为空串）", () => {
    const probeScene = { ...createInitialScene(), node: "probe" as const };
    const beats = composeBeats(context({ scene: probeScene, userText: "今天店里很安静" }));
    expect(beats).toContainEqual(expect.objectContaining({ say: "", suggest: "glance_window" }));
  });

  it("咖啡台词暗示「一直没人动」，不说成给用户点的", () => {
    const line = composeBeats(context({ scene: createInitialScene(), userText: "今天店里很安静" }))[1]?.say ?? "";
    expect(line).toContain("咖啡");
    expect(line).toContain("没人");
    expect(line).not.toContain("给你点");
  });
});

describe("mockLlm：流式与取消", () => {
  it("每 beat 之间延迟，且可注入指定输出", async () => {
    const ctx = context();
    const llm = createMockLlm({ beatDelayMs: 20, script: () => [{ say: "a" }, { say: "b" }] });
    const signal = new AbortController().signal;
    const startedAt = Date.now();
    const received: unknown[] = [];
    for await (const beat of llm.streamBeats(ctx, signal)) received.push(beat);
    expect(received).toHaveLength(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });

  it("中止后以 AbortError 结束且不再产出", async () => {
    const llm = createMockLlm({ beatDelayMs: 500 });
    const controller = new AbortController();
    const iterator = llm.streamBeats(context(), controller.signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});
