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
  /** S6l-fix2 §6：推进可注入时钟，跳过 poke / gift 冷却。 */
  advanceClock(ms: number): void;
};

let active: SessionManager | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
});

function setup(): Harness {
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  let nowMs = 1_000_000;
  const manager = createSessionManager({
    stt: createMockStt({ delayMs: 0 }),
    llm: createMockLlm({ beatDelayMs: 0 }),
    tts: { synthesize: async () => ({ mime: "audio/mpeg", data: Buffer.alloc(16_000) }) },
    packs: testPacks(),
    log: () => {},
    now: () => nowMs,
  });
  active = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: nowMs, type, payload }) as ClientMessage;

  let sessionId = "";
  return {
    manager,
    sent,
    advanceClock: (ms) => void (nowMs += ms),
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

    // S6l-fix2 §6：第二次 poke 要跳过服务端 3 秒冷却才会起新轮。
    harness.advanceClock(3_000);
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

/**
 * S6l-fix2 §6：服务端限量 poke / gift——冷却内重复请求直接忽略（不起新轮、不扣轮数）。
 * 用可注入时钟推进冷却。
 */
describe("S6l-fix2 §6：服务端 poke / gift 限流", () => {
  it("3 秒内的第二次 poke 被忽略（不起新轮、无 beat）", async () => {
    const harness = setup();
    await harness.hello();

    await harness.input("", 1, "poke");
    expect(harness.beats(1)).toHaveLength(2);
    // 冷却内重复：turnId 更大但应被忽略。
    await harness.input("", 2, "poke");
    expect(harness.beats(2)).toHaveLength(0);
  });

  it("超过 3 秒后的 poke 正常起轮", async () => {
    const harness = setup();
    await harness.hello();

    await harness.input("", 1, "poke");
    harness.advanceClock(3_000);
    await harness.input("", 2, "poke");
    expect(harness.beats(2)).toHaveLength(2);
  });

  it("礼物冷却 10 秒：5 秒内第二次 gift 被忽略，10 秒后正常", async () => {
    const harness = setup();
    await harness.hello();

    await harness.input("", 1, "gift");
    expect(harness.beats(1).length).toBeGreaterThan(0);

    harness.advanceClock(5_000);
    await harness.input("", 2, "gift");
    expect(harness.beats(2)).toHaveLength(0);

    harness.advanceClock(5_000);
    await harness.input("", 3, "gift");
    expect(harness.beats(3).length).toBeGreaterThan(0);
  });
});

/**
 * S6m §0：被限流的 poke / gift 仍回一条**无 beat**的 turn_end{reason:"throttled"}，
 * 否则客户端已经 beginTurn 进入 thinking，等不到 turn_end 会一直卡着。
 */
describe("S6m §0：限流的 poke / gift 回 turn_end{throttled}", () => {
  it("3 秒内第二次 poke：收到 turn_end{reason:'throttled'}，且无 beat", async () => {
    const harness = setup();
    await harness.hello();

    await harness.input("", 1, "poke");
    expect(harness.beats(1)).toHaveLength(2);

    // 冷却内重复：turnId 更大但应被限流。
    await harness.input("", 2, "poke");
    expect(harness.beats(2)).toHaveLength(0);
    const end = harness.sent.findLast(
      (m) => m.type === "turn_end" && m.turnId === 2,
    );
    expect(end?.type).toBe("turn_end");
    expect(end?.type === "turn_end" ? end.payload.reason : null).toBe("throttled");
  });

  it("礼物冷却内的第二次 gift 同样回 throttled", async () => {
    const harness = setup();
    await harness.hello();

    await harness.input("", 1, "gift");
    harness.advanceClock(5_000);
    await harness.input("", 2, "gift");

    expect(harness.beats(2)).toHaveLength(0);
    const end = harness.sent.findLast((m) => m.type === "turn_end" && m.turnId === 2);
    expect(end?.type === "turn_end" ? end.payload.reason : null).toBe("throttled");
  });

  it("被限流的一轮不扣轮数：第二次 throttled 后仍能正常起新轮（无 quota 错误）", async () => {
    const harness = setup();
    await harness.hello();

    await harness.input("", 1, "poke");
    await harness.input("", 2, "poke"); // 被限流
    harness.advanceClock(3_000);
    await harness.input("", 3, "poke"); // 冷却过后正常

    expect(harness.beats(3).length).toBeGreaterThan(0);
    expect(harness.sent.some((m) => m.type === "error" && m.payload.code === "quota_exceeded")).toBe(false);
  });
});
