import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { createMockLlm } from "../src/adapters/mock/mockLlm";
import { createMockStt } from "../src/adapters/mock/mockStt";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPacks } from "./helpers/pack";

/**
 * S6l §5 集成：poke / gift 一轮完整走通（Mock）。
 * 断言：Mock 用 pack.events 的台词回应；gift 第一句 accent=love 且 fx=hearts；
 * poke 第一句 accent=shy（第一次），第二轮 poke = angry。
 */

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  sessionId: string;
  hello(): Promise<void>;
  input(text: string, turnId: number, kind?: "text" | "poke" | "gift"): Promise<void>;
  beats(turnId: number): Array<NonNullable<Extract<ServerMessage, { type: "beat" }>["payload"]["beat"]>>;
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
    stt: createMockStt({ delayMs: 0 }),
    llm: createMockLlm({ beatDelayMs: 0 }),
    tts: { synthesize: async () => ({ mime: "audio/mpeg", data: Buffer.alloc(16_000) }) },
    packs: testPacks(),
    log: () => {},
  });
  active = manager;

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
    async input(text, turnId, kind) {
      await manager.handleMessage(send, envelope("text_input", kind === undefined ? { text } : { text, kind }, sessionId, turnId));
    },
    beats(turnId) {
      return sent
        .filter((m) => m.type === "beat" && m.turnId === turnId)
        .map((m) => (m.type === "beat" ? m.payload.beat : null))
        .filter((beat): beat is NonNullable<typeof beat> => beat !== null);
    },
  };
}

describe("S6l §5 集成：poke / gift（Mock）", () => {
  it("gift：用 events.gift 台词回应，第一句 accent=love 且 fx=hearts", async () => {
    const harness = setup();
    await harness.hello();
    await harness.input("", 1, "gift");

    const beats = harness.beats(1);
    expect(beats.map((beat) => beat.say)).toEqual(["诶，谢谢你的礼物！", "下播了还送，你人也太好了吧。"]);
    expect(beats[0]?.accent).toBe("love");
    expect(beats[0]?.fx).toBe("hearts");
  });

  it("poke：用 events.poke 台词回应，第一次 accent=shy，第二次 accent=angry", async () => {
    const harness = setup();
    await harness.hello();

    await harness.input("", 1, "poke");
    const first = harness.beats(1);
    expect(first.map((beat) => beat.say)).toEqual(["干嘛戳我。", "再戳要收费了哦。"]);
    expect(first[0]?.accent).toBe("shy");

    await harness.input("", 2, "poke");
    const second = harness.beats(2);
    expect(second[0]?.accent).toBe("angry");
  });

  it("poke / gift 不当作观众台词（不触发换背景检测、不推进剧情）", async () => {
    const harness = setup();
    await harness.hello();
    await harness.input("", 1, "gift");
    // arrive 节点不会因 gift 推进（gift 不产生 advance）。
    const beats = harness.beats(1);
    expect(beats.every((beat) => beat.story === null)).toBe(true);
    expect(harness.sent.some((m) => m.type === "scene_status")).toBe(false);
  });
});
