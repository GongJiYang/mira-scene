/**
 * 冒烟脚本：真实 WS 连接 + 随机端口，验证 hello → 多轮 → 打断 → stale_turn。
 * 任何一步失败以非 0 退出码结束。
 */
import WebSocket from "ws";
import { parseServerMessage, type ServerMessage } from "@mira/protocol";
import { startServer } from "../src/index";

type Waiter = {
  predicate: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
};

const inbox: ServerMessage[] = [];
const waiters: Waiter[] = [];

function fail(reason: string): never {
  console.error(`SMOKE FAIL: ${reason}`);
  throw new Error(reason);
}

function now(): number {
  return Date.now();
}

/** 等待（含已收到的）满足条件的下行消息；真实网络等待，超时即失败。 */
function waitForMessage(predicate: (message: ServerMessage) => boolean, label: string, timeoutMs = 8_000): Promise<ServerMessage> {
  const existing = inbox.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise<ServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.findIndex((waiter) => waiter.resolve === wrappedResolve);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`等待超时：${label}`));
    }, timeoutMs);
    const wrappedResolve = (message: ServerMessage) => {
      clearTimeout(timer);
      resolve(message);
    };
    waiters.push({ predicate, resolve: wrappedResolve });
  });
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function main(): Promise<void> {
  const server = await startServer({ port: 0 });
  const health = (await fetch(`http://127.0.0.1:${server.port}/health`).then((response) => response.json())) as { ok?: boolean };
  if (health?.ok !== true) fail(`/health 异常：${JSON.stringify(health)}`);

  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  let seq = 0;
  let sessionId = "";
  let turnId = 0;

  socket.on("message", (raw) => {
    const parsed = parseServerMessage(JSON.parse(raw.toString()));
    if (!parsed.success) {
      fail(`收到非法 ServerMessage：${parsed.error.message}`);
      return;
    }
    inbox.push(parsed.data);
    const pending = [...waiters];
    for (const waiter of pending) {
      if (waiter.predicate(parsed.data)) {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        waiter.resolve(parsed.data);
      }
    }
  });

  const send = (type: "hello" | "text_input", payload: Record<string, unknown>, envelopeTurnId: number): void => {
    socket.send(
      JSON.stringify({ v: 1, sessionId, turnId: envelopeTurnId, seq: seq++, ts: now(), type, payload }),
    );
  };

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });

    const timings: Array<{ step: string; ms: number }> = [];
    const startedAt = now();

    // 1. hello → session
    send("hello", {}, 0);
    const session = await waitForMessage((message) => message.type === "session", "session");
    if (session.type !== "session") return;
    sessionId = session.sessionId;
    if (session.payload.snapshot.node !== "arrive") fail(`初始 node 应为 arrive，实际 ${session.payload.snapshot.node}`);
    timings.push({ step: "hello → session", ms: now() - startedAt });

    // 2. 第 1 轮：收到至少 1 个 turnId=1 的 beat
    turnId = 1;
    const turn1At = now();
    send("text_input", { text: "你好" }, turnId);
    const firstBeat = await waitForMessage(
      (message) => message.type === "beat" && message.turnId === 1,
      "turn 1 的第一个 beat",
    );
    if (firstBeat.type !== "beat") return;
    timings.push({ step: "turn1 → 首个 beat", ms: now() - turn1At });

    // 3. turn 1 尚未 turn_end 时发出第 2 轮
    if (inbox.some((message) => message.type === "turn_end" && message.turnId === 1)) {
      fail("turn 1 在第 2 轮发出前就结束了，打断场景未成立");
    }
    const marker = inbox.length;
    turnId = 2;
    const turn2At = now();
    send("text_input", { text: "你在等谁？" }, turnId);

    // 5. 第 2 轮正常收到 turn_end{done}
    const turn2End = await waitForMessage(
      (message) => message.type === "turn_end" && message.turnId === 2 && message.payload.reason === "done",
      "turn 2 turn_end(done)",
    );
    if (turn2End.type !== "turn_end") return;
    timings.push({ step: "turn2 → turn_end(done)", ms: now() - turn2At });

    // 4. 从发出第 2 轮开始，再也没有 turnId=1 的消息（再等 2 秒确认）
    await delay(2_000);
    const staleMessages = inbox.slice(marker).filter((message) => message.turnId === 1);
    if (staleMessages.length > 0) {
      fail(`打断后仍收到 turnId=1 的消息：${staleMessages.map((message) => message.type).join(",")}`);
    }
    const turn2Tts = inbox.filter((message) => message.type === "tts_audio" && message.turnId === 2);
    if (turn2Tts.length === 0) fail("turn 2 没有收到 tts_audio");
    const turn2Beats = inbox.filter((message) => message.type === "beat" && message.turnId === 2);
    if (turn2Beats.length < 2) fail(`turn 2 只收到 ${turn2Beats.length} 个 beat`);
    timings.push({ step: "打断确认（等待 2s）", ms: 2_000 });

    // 6. 重复 turnId=2 → stale_turn
    const staleAt = now();
    send("text_input", { text: "重复" }, 2);
    const stale = await waitForMessage(
      (message) => message.type === "error" && message.payload.code === "stale_turn",
      "error(stale_turn)",
    );
    if (stale.type !== "error") return;
    if (stale.payload.retryable !== false) fail("stale_turn 应为 retryable=false");
    timings.push({ step: "重复 turnId → stale_turn", ms: now() - staleAt });

    // 7. 打印各步耗时
    console.log("SMOKE OK");
    console.table(timings);
    console.log(`总耗时 ${now() - startedAt}ms；turn2 beats=${turn2Beats.length} tts=${turn2Tts.length}`);
  } finally {
    socket.close();
    await server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
