/**
 * §1 集成：一个「从不输出 advance」的假 LLM——推进完全靠服务端保底。
 *
 * 覆盖：
 * - 真实用户输入若干轮后依次到达 probe → reveal → ending（ending 仍需 reveal 后 2 轮）；
 * - ask_core / comfort 命中时**当轮**强制推进；
 * - nudge / poke / gift 不推进计数；
 * - 日志含 `story_forced`。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage, StoryNode } from "@mira/protocol";
import type { LogRecord } from "../src/log";
import type { LLMPort } from "../src/ports";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPacks } from "./helpers/pack";

/** 假 LLM：永远只说一句话，绝不输出 advance。 */
function createNeverAdvancingLlm(): LLMPort {
  return {
    async *streamBeats(): AsyncIterable<unknown> {
      yield { say: "嗯。", emotion: "calm" };
      yield { say: "", emotion: "calm" };
    },
  };
}

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  logs: LogRecord[];
  sessionId: string;
  nodes: StoryNode[];
  hello(): Promise<void>;
  input(turnId: number, text: string, kind?: "text" | "poke" | "gift"): Promise<void>;
  nudge(turnId: number): Promise<void>;
};

let active: SessionManager | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
});

function setup(): Harness {
  const sent: ServerMessage[] = [];
  const logs: LogRecord[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const manager = createSessionManager({
    stt: { transcribe: async () => "" },
    llm: createNeverAdvancingLlm(),
    tts: { synthesize: async () => ({ mime: "audio/mpeg", data: Buffer.alloc(16_000) }) },
    packs: testPacks(),
    log: (record) => void logs.push(record),
  });
  active = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

  let sessionId = "";
  const nodes: StoryNode[] = [];
  const track = (): void => {
    const snapshot = sent.findLast((m) => m.type === "state_snapshot");
    if (snapshot && snapshot.type === "state_snapshot") {
      const node = snapshot.payload.snapshot.node;
      if (nodes.at(-1) !== node) nodes.push(node);
    }
  };
  return {
    manager,
    sent,
    logs,
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
    async input(turnId, text, kind) {
      await manager.handleMessage(
        send,
        envelope("text_input", kind === undefined ? { text } : { text, kind }, sessionId, turnId),
      );
      track();
    },
    async nudge(turnId) {
      await manager.handleMessage(send, envelope("nudge", {}, sessionId, turnId));
      track();
    },
  };
}

describe("§1 集成：从不输出 advance 的假 LLM 靠保底推进", () => {
  it("真实用户轮依次到达 probe → reveal → ending", async () => {
    const h = setup();
    await h.hello();

    // arrive → probe：allowed 需 userTurns>=1（历史里用户真实轮数）。第 1 轮后 userTurns=1 → 允许。
    // 但 arrive 阶段计数从 0 起：turn1 时 allowed 为 null（userTurns=0），不推进；
    // turn2 起 allowed 非空，连续 2 真实轮未推进才强制。
    await h.input(1, "你好");
    await h.input(2, "在吗");
    await h.input(3, "嗯嗯");
    expect(h.nodes).toContain("probe");

    // probe → reveal：allowed 需 trust>=2 / ask_core / turnCount>=8。走 turnCount>=8 或 trust。
    for (let turnId = 4; turnId <= 12; turnId += 1) {
      await h.input(turnId, "再聊聊");
      if (h.nodes.includes("reveal")) break;
    }
    expect(h.nodes).toContain("reveal");

    // reveal → ending：进入 reveal 后 2 轮。
    let turnId = 13;
    for (; turnId <= 20; turnId += 1) {
      await h.input(turnId, "然后呢");
      if (h.nodes.includes("ending")) break;
    }
    expect(h.nodes).toContain("ending");
    expect(h.nodes[0]).toBe("arrive");
    expect(h.logs.some((record) => record.event === "story_forced")).toBe(true);
  });

  it("ask_core 命中 → 当轮进入 reveal（无需等 2 轮）", async () => {
    const h = setup();
    await h.hello();
    // 先把 arrive → probe 顶过去（连续 2 真实轮）。
    await h.input(1, "你好");
    await h.input(2, "在吗");
    await h.input(3, "嗯嗯");
    expect(h.nodes).toContain("probe");

    // 「你为什么不睡？」命中 ask_core → probe 允许 reveal；forceNow 当轮强制。
    const before = h.nodes.length;
    await h.input(4, "你为什么不睡？");
    expect(h.nodes.at(-1)).toBe("reveal");
    expect(h.nodes.length).toBeGreaterThan(before);
  });

  it("nudge / poke / gift 不推进计数（不因它们提前推进）", async () => {
    const h = setup();
    await h.hello();
    // 第 1 真实轮：allowed 为 null（userTurns=0），不推进。
    await h.input(1, "你好");
    expect(h.nodes).not.toContain("probe");
    // 插入 nudge / poke / gift：不应让计数推进（arrive 仍不推进）。
    await h.nudge(2);
    await h.input(3, "（戳）", "poke");
    await h.input(4, "（礼物）", "gift");
    expect(h.nodes).not.toContain("probe");
    // 再补真实轮：第 2、3 真实轮 → 触发保底推进。
    await h.input(5, "在吗");
    await h.input(6, "嗯嗯");
    expect(h.nodes).toContain("probe");
  });
});
