import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { createMockLlm, composeBeats } from "../src/adapters/mock/mockLlm";
import { createMockStt } from "../src/adapters/mock/mockStt";
import { createMockTts } from "../src/adapters/mock/mockTts";
import { silentLogger } from "../src/log";
import type { LLMContext, LLMPort } from "../src/ports";
import { renderPrompt, NUDGE_SCENE_NOTE } from "../src/prompts/renderPrompt";
import { createSessionManager, NUDGE_USER_TEXT, type SendFn, type SessionManager } from "../src/session";
import { createInitialScene } from "../src/story";
import { testPack, testPacks } from "./helpers/pack";

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  hello(): Promise<void>;
  input(turnId: number, text: string): Promise<void>;
  nudge(turnId: number): Promise<void>;
};

let active: SessionManager | null = null;

function setup(options: { llm?: LLMPort; sessionTurnLimit?: number; dailyTurnLimit?: number } = {}): Harness {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const manager = createSessionManager({
    stt: createMockStt({ delayMs: 0 }),
    llm: options.llm ?? createMockLlm({ beatDelayMs: 0 }),
    tts: createMockTts({ delayMs: 0 }),
    log: silentLogger,
    packs: testPacks(),
    sessionTurnLimit: options.sessionTurnLimit,
    dailyTurnLimit: options.dailyTurnLimit,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
  });
  active = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

  const sessionIdOf = (): string => sent.findLast((message) => message.type === "session")?.sessionId ?? "";

  return {
    manager,
    sent,
    async hello() {
      await manager.handleMessage(send, envelope("hello", {}, "", 0));
    },
    input: (turnId, text) => manager.handleMessage(send, envelope("text_input", { text }, sessionIdOf(), turnId)),
    nudge: (turnId) => manager.handleMessage(send, envelope("nudge", {}, sessionIdOf(), turnId)),
  };
}

const errorsOf = (sent: ServerMessage[], turnId: number) =>
  sent.filter((message) => message.type === "error" && message.turnId === turnId);

afterEach(() => {
  active?.dispose();
  active = null;
});

describe("mockLlm：主动开口脚本（D32）", () => {
  it("nudge 时返回一句主动台词 + 一个无声动作，且不推进剧情", () => {
    const beats = composeBeats({ history: [], scene: createInitialScene(), userText: NUDGE_USER_TEXT, pack: testPack("rin"), nudge: true }, testPack("rin"));
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.some((beat) => beat.say !== "")).toBe(true);
    expect(beats.some((beat) => beat.say === "" && beat.suggest !== null)).toBe(true);
    expect(beats.every((beat) => beat.advance === null)).toBe(true);
  });
});

describe("服务端 nudge：不推进剧情、不计入限额（§7）", () => {
  it("user_text 固定为「客人安静地坐着」，且 nudge 标记为 true", async () => {
    const seen: Array<{ userText: string; nudge: boolean | undefined }> = [];
    const llm: LLMPort = {
      async *streamBeats(ctx: LLMContext) {
        seen.push({ userText: ctx.userText, nudge: ctx.nudge });
        yield { say: "……你还在听吗？", emotion: "calm", suggest: null, advance: null };
      },
    };
    const harness = setup({ llm });
    await harness.hello();
    await harness.nudge(1);

    expect(seen).toEqual([{ userText: NUDGE_USER_TEXT, nudge: true }]);
    const turnEnd = harness.sent.findLast((message) => message.type === "turn_end");
    expect(turnEnd?.payload).toEqual({ reason: "done" });
  });

  it("主动开口轮即使 LLM 提议推进剧情也不生效（trust 不变）", async () => {
    const llm: LLMPort = {
      async *streamBeats() {
        yield { say: "……", emotion: "calm", suggest: "drink", advance: "probe" };
      },
    };
    const harness = setup({ llm });
    await harness.hello();
    await harness.nudge(1);

    const beat = harness.sent.find((message) => message.type === "beat");
    expect(beat).toMatchObject({ payload: { beat: { story: null } } });
    const snapshot = harness.sent.find((message) => message.type === "state_snapshot");
    expect(snapshot?.payload.snapshot).toMatchObject({ node: "arrive", trust: 0 });
  });

  it("会话限额为 1：一轮对话用满后，nudge 仍可进行，且不占用额度", async () => {
    const harness = setup({ sessionTurnLimit: 1, dailyTurnLimit: 1 });
    await harness.hello();
    await harness.input(1, "你好");

    // 额度已用满：主动开口仍应被接受。
    await harness.nudge(2);
    expect(errorsOf(harness.sent, 2)).toEqual([]);
    expect(harness.sent.some((message) => message.type === "beat" && message.turnId === 2)).toBe(true);
    expect(harness.sent.findLast((message) => message.type === "turn_end")?.payload).toEqual({ reason: "done" });

    // 但随后的正常输入仍会撞上限额，证明 nudge 没有消耗额度。
    await harness.input(3, "再说一句");
    expect(errorsOf(harness.sent, 3)).toMatchObject([{ payload: { code: "quota_exceeded" } }]);
  });

  it("nudge 的 turnId 仍需递增：重复 turnId 返回 stale_turn", async () => {
    const harness = setup();
    await harness.hello();
    await harness.nudge(1);
    await harness.nudge(1);
    expect(errorsOf(harness.sent, 1).map((message) => (message.type === "error" ? message.payload.code : ""))).toContain(
      "stale_turn",
    );
  });
});

describe("提示词：主动开口的动态后缀（§7）", () => {
  it("nudge 时给动态后缀追加沉默提示，普通轮不加", () => {
    const prompt = testPack("rin");
    const scene = createInitialScene();
    const nudge = renderPrompt(prompt, {
      scene,
      history: [],
      userText: NUDGE_USER_TEXT,
      nudge: true,
    });
    expect(nudge[1]?.content).toContain(NUDGE_SCENE_NOTE);

    const normal = renderPrompt(prompt, {
      scene,
      history: [],
      userText: "你好",
    });
    expect(normal[1]?.content).not.toContain(NUDGE_SCENE_NOTE);
  });
});
