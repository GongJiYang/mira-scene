import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage, StoryNode } from "@mira/protocol";
import type { LLMContext, LLMPort } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { renderPrompt } from "../src/prompts/renderPrompt";
import { createInitialScene } from "../src/story";
import { testPacks } from "./helpers/pack";

/**
 * S6l §1 集成：一个「照提示词办事」的假 LLM。
 *
 * 它读渲染后提示词里的 `advance_rule`：若写着「允许进入 X」，就在这一轮的最后一句带上
 * `advance:"X"`。这样推进**完全由提示词驱动**——只要 advanceRule 与 story.ts 的 NEXT_NODE
 * 不一致，这个用例就会失败，从而防止 Mock 单独推进掩盖真实模式的 bug。
 *
 * 台词不写死：直接从渲染后的提示词里取当前节点 label，保证 say 非空即可。
 */

/** 从渲染后的 user 消息里读出 advance_rule 允许的目标节点。 */
function allowedNode(ctx: LLMContext): StoryNode | null {
  const messages = renderPrompt(ctx.pack, { scene: ctx.scene, history: ctx.history, userText: ctx.userText });
  const dynamic = messages[messages.length - 1]?.content ?? "";
  const match = /允许进入 (\w+)/.exec(dynamic);
  return match ? (match[1] as StoryNode) : null;
}

/** 假 LLM：产出两句台词 + 一个无声动作 beat，并在最后一句挂 advance（若提示词允许）。 */
function createPromptObeyingLlm(): LLMPort {
  return {
    async *streamBeats(ctx): AsyncIterable<unknown> {
      const target = allowedNode(ctx);
      yield { say: `好，${ctx.scene.node}。`, emotion: "calm" };
      yield { say: "嗯。", emotion: "calm", advance: target };
      yield { say: "", emotion: "calm" };
    },
  };
}

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  sessionId: string;
  nodes: StoryNode[];
  hello(): Promise<void>;
  input(turnId: number, text: string): Promise<void>;
};

let active: SessionManager | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
});

function setup(): Harness {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const manager = createSessionManager({
    stt: { transcribe: async () => "" },
    llm: createPromptObeyingLlm(),
    tts: { synthesize: async () => ({ mime: "audio/mpeg", data: Buffer.alloc(16_000) }) },
    packs: testPacks(),
    log: () => {},
  });
  active = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

  let sessionId = "";
  const nodes: StoryNode[] = [];
  return {
    manager,
    sent,
    nodes,
    get sessionId() {
      return sessionId;
    },
    async hello() {
      await manager.handleMessage(send, envelope("hello", {}, "", 0));
      const session = sent.findLast((m) => m.type === "session");
      if (!session || session.type !== "session") throw new Error("没有收到 session");
      sessionId = session.sessionId;
      nodes.push(session.payload.snapshot.node);
    },
    async input(turnId, text) {
      await manager.handleMessage(send, envelope("text_input", { text }, sessionId, turnId));
      const snapshot = sent.findLast((m) => m.type === "state_snapshot");
      if (snapshot && snapshot.type === "state_snapshot") {
        const node = snapshot.payload.snapshot.node;
        if (nodes.at(-1) !== node) nodes.push(node);
      }
    },
  };
}

describe("S6l §1 集成：照提示词办事的假 LLM 从 arrive 走到 ending", () => {
  it("四个节点依次出现（推进完全由提示词驱动）", async () => {
    const harness = setup();
    await harness.hello();

    // arrive → probe：第 2 轮（用户已说过至少 1 轮，与 Mock 的 priorUserTurns>=1 一致）。
    await harness.input(1, "你好");
    expect(harness.nodes).not.toContain("probe");
    await harness.input(2, "在吗");
    expect(harness.nodes).toContain("probe");

    // probe → reveal：温和地直接问起（ask_core）。
    await harness.input(3, "你为什么不睡？");
    expect(harness.nodes).toContain("reveal");

    // reveal → ending：进入 reveal 两轮之后。
    await harness.input(4, "嗯。");
    await harness.input(5, "然后呢");
    expect(harness.nodes).toContain("ending");

    expect(harness.nodes[0]).toBe("arrive");
    expect(harness.nodes).toEqual(["arrive", "probe", "reveal", "ending"]);
  });

  it("arrive 第 0 轮（历史无用户轮）不允许推进", async () => {
    const packs = testPacks();
    const pack = packs.get("yuna");
    if (!pack) throw new Error("缺少 yuna 包");
    const messages = renderPrompt(pack, { scene: { ...createInitialScene(), node: "arrive" }, history: [], userText: "你好" });
    expect(messages[messages.length - 1]?.content).toContain("现在不要推进剧情");
  });
});
