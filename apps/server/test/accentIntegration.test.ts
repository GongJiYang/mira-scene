import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { createMockLlm } from "../src/adapters/mock/mockLlm";
import { createMockStt } from "../src/adapters/mock/mockStt";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPacks } from "./helpers/pack";
import { initialState, reducer, type ClientState } from "../../client/src/state";

/**
 * D47 §6 集成：Mock 会话里带 accent 的 beat 经服务端到客户端 store 完整保留。
 * 用真实会话管理器 + Mock LLM/STT/TTS（不发真实网络），再喂给客户端 A 状态机 reducer。
 */

const ONE_SECOND_BYTES = 16_000;

function setup(): { manager: SessionManager; sent: ServerMessage[]; sessionId: string; hello(): Promise<void>; input(text: string, turnId: number): Promise<void> } {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  const manager = createSessionManager({
    stt: createMockStt({ delayMs: 0 }),
    llm: createMockLlm({ beatDelayMs: 0 }),
    tts: { synthesize: async () => ({ mime: "audio/mpeg", data: Buffer.alloc(ONE_SECOND_BYTES) }) },
    packs: testPacks(),
    log: () => {},
  });

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

  let sessionId = "";
  return {
    manager,
    sent,
    get sessionId() {
      return sessionId;
    },
    async hello() {
      await manager.handleMessage(send, envelope("hello", {}, "", 0));
      const session = sent.findLast((m) => m.type === "session");
      if (!session || session.type !== "session") throw new Error("没有收到 session");
      sessionId = session.sessionId;
    },
    async input(text, turnId) {
      await manager.handleMessage(send, envelope("text_input", { text }, sessionId, turnId));
    },
  };
}

let active: SessionManager | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
});

describe("D47 §6 集成：Mock accent 经服务端到客户端 store", () => {
  it("arrive 轮的第一句带 accent=amazed，且经 reducer 后 store.visual.accent 保留", async () => {
    const harness = setup();
    active = harness.manager;
    await harness.hello();
    await harness.input("你好", 1);

    const beats = harness.sent
      .filter((m) => m.type === "beat" && m.turnId === 1)
      .map((m) => (m.type === "beat" ? m.payload.beat : null))
      .filter((beat): beat is NonNullable<typeof beat> => beat !== null);
    expect(beats.length).toBeGreaterThanOrEqual(1);
    // Mock arrive 节点 look.accent = amazed，放在这一轮第一句。
    expect(beats[0]?.accent).toBe("amazed");

    // 喂给客户端 A 状态机：BEAT_AUDIO_STARTED 之后 accent 进入 visual。
    let state: ClientState = reducer(initialState, { type: "SUBMIT_TEXT" });
    for (const beat of beats) {
      state = reducer(state, {
        type: "SERVER_MESSAGE",
        message: { v: 1, sessionId: harness.sessionId, turnId: 1, seq: beat.seq, ts: Date.now(), type: "beat", payload: { beat } },
      });
    }
    expect(state.queue[0]?.accent).toBe("amazed");
    state = reducer(state, { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 });
    expect(state.visual.accent).toBe("amazed");
  });
});
