import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { createMockLlm } from "../src/adapters/mock/mockLlm";
import { createMockStt } from "../src/adapters/mock/mockStt";
import { createMockTts } from "../src/adapters/mock/mockTts";
import { silentLogger } from "../src/log";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPacks } from "./helpers/pack";

/**
 * S6b §1 / §6：两个角色包都能在 Mock 模式下跑完 arrive → ending；
 * 未知 characterId 返回 unknown_character 并关闭会话（不回退夏凛）。
 */

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  closed: number;
  hello(payload: Record<string, unknown>): Promise<void>;
  input(turnId: number, text: string): Promise<void>;
};

let active: SessionManager | null = null;

function setup(): Harness {
  const sent: ServerMessage[] = [];
  let closed = 0;
  const send: SendFn = (message) => void sent.push(message);
  const manager = createSessionManager({
    stt: createMockStt({ delayMs: 0 }),
    llm: createMockLlm({ beatDelayMs: 0 }),
    tts: createMockTts({ delayMs: 0 }),
    packs: testPacks(),
    closeConnection: () => {
      closed += 1;
    },
    log: silentLogger,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
  });
  active = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: Date.now(), type, payload }) as ClientMessage;

  const sessionIdOf = (): string => sent.findLast((message) => message.type === "session")?.sessionId ?? "";

  return {
    manager,
    sent,
    get closed() {
      return closed;
    },
    async hello(payload) {
      await manager.handleMessage(send, envelope("hello", payload, "", 0));
    },
    input: (turnId, text) => manager.handleMessage(send, envelope("text_input", { text }, sessionIdOf(), turnId)),
  };
}

afterEach(() => {
  active?.dispose();
  active = null;
});

const lastSnapshot = (sent: ServerMessage[]) =>
  sent.filter((message) => message.type === "state_snapshot").at(-1)?.payload.snapshot;

describe("角色包：hello.characterId（S6b §1）", () => {
  it("缺省 → rin（兼容旧客户端）", async () => {
    const harness = setup();
    await harness.hello({});
    const session = harness.sent.find((message) => message.type === "session");
    expect(session).toBeDefined();
    expect(harness.closed).toBe(0);
  });

  it("显式 yuna → 会话建立，且台词来自忧奈的剧本", async () => {
    const harness = setup();
    await harness.hello({ characterId: "yuna" });
    await harness.input(1, "你好");

    const beats = harness.sent.flatMap((message) =>
      message.type === "beat" ? [message.payload.beat.say] : [],
    );
    // 忧奈 arrive/greeting 的两句（来自 characters/yuna/content.json）。
    expect(beats).toContain("……诶？还有人？");
    expect(beats).toContain("我以为大家都走了，推流忘关了。");
  });

  it("未知 id → error{unknown_character} 并关闭会话，不回退夏凛", async () => {
    const harness = setup();
    await harness.hello({ characterId: "nobody" });

    const error = harness.sent.find((message) => message.type === "error");
    expect(error).toMatchObject({ payload: { code: "unknown_character", retryable: false } });
    expect(harness.sent.some((message) => message.type === "session")).toBe(false);
    expect(harness.closed).toBe(1);
  });
});

describe("角色包：Mock 模式跑完 arrive → ending（S6b §6）", () => {
  /** 各角色能命中 ask_core（revealIntents 之一）的代表输入。 */
  const ASK_CORE: Record<"rin" | "yuna", string> = {
    rin: "你在等谁？",
    yuna: "还不睡吗？",
  };

  for (const id of ["rin", "yuna"] as const) {
    it(`${id}：四轮推进到 ending`, async () => {
      const harness = setup();
      await harness.hello({ characterId: id });

      // arrive → probe（第 2 次输入起）
      await harness.input(1, "你好");
      await harness.input(2, "你好");
      expect(lastSnapshot(harness.sent)?.node).toBe("probe");

      // probe → reveal（ask_core 是 revealIntents 之一）
      await harness.input(3, ASK_CORE[id]);
      expect(lastSnapshot(harness.sent)?.node).toBe("reveal");

      // reveal → ending
      await harness.input(4, "然后呢");
      expect(lastSnapshot(harness.sent)?.node).toBe("ending");

      // 每个角色都正常结束每一轮。
      const turnEnds = harness.sent.filter((message) => message.type === "turn_end");
      expect(turnEnds).toHaveLength(4);
      expect(turnEnds.every((message) => message.type === "turn_end" && message.payload.reason === "done")).toBe(true);
    });
  }

  it("两个角色的台词互不相同（确认按 pack 取剧本）", async () => {
    const rin = setup();
    await rin.hello({ characterId: "rin" });
    await rin.input(1, "你好");
    const rinBeats = rin.sent.flatMap((message) => (message.type === "beat" ? [message.payload.beat.say] : []));
    rin.manager.dispose();

    const yuna = setup();
    await yuna.hello({ characterId: "yuna" });
    await yuna.input(1, "你好");
    const yunaBeats = yuna.sent.flatMap((message) => (message.type === "beat" ? [message.payload.beat.say] : []));

    expect(rinBeats).toContain("雨还在下。");
    expect(yunaBeats).toContain("……诶？还有人？");
    // 无声 beat 的 say 都是空串，比较时排除。
    const spoken = (lines: string[]) => lines.filter((line) => line !== "");
    expect(spoken(rinBeats).some((line) => spoken(yunaBeats).includes(line))).toBe(false);
  });
});
