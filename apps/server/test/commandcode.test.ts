import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CMD_ARGS, createCommandCodeLlm, type SpawnFn, type SpawnLike } from "../src/adapters/commandcode/commandCodeLlm";
import type { LogRecord } from "../src/log";
import type { LLMContext } from "../src/ports";
import type { PromptTemplate } from "../src/prompts/loader";
import { createInitialScene } from "../src/story";

const PROMPT: PromptTemplate = {
  version: "rin.test",
  staticText: "静态前缀",
  dynamicTemplate: "动态 {{user_text}}",
  source: "mem",
};

function context(userText = "你好"): LLMContext {
  return { history: [], scene: createInitialScene(), userText };
}

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

function textDelta(delta: string): string {
  return line({ type: "event", event: { type: "text_delta", delta } });
}

/** 把 push 进来的字符串按写入顺序吐给 async 迭代器，`end` 后结束。 */
class PushStream {
  private queue: string[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(data: string): void {
    this.queue.push(data);
    const waiter = this.waiters.shift();
    waiter?.();
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift() as string;
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** 一个假的子进程：可控地把 stdout 一段段吐出，最后 close。 */
class FakeChild extends EventEmitter implements SpawnLike {
  stdout: PushStream;
  stderr: Readable;
  stdin = { end: () => undefined };
  killed: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdout = new PushStream();
    this.stderr = new Readable({ read: () => undefined });
    this.stderr.push(null);
  }

  push(data: string): void {
    this.stdout.push(data);
  }

  end(code = 0, signal: NodeJS.Signals | null = null): void {
    this.stdout.close();
    this.emit("close", code, signal);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = signal;
    // 中止时子进程被 kill → close。
    queueMicrotask(() => {
      this.stdout.close();
      this.emit("close", null, signal);
    });
    return true;
  }
}

type SpawnHarness = {
  spawn: SpawnFn;
  children: FakeChild[];
  calls: Array<{ command: string; args: readonly string[]; cwd: string }>;
};

function makeSpawn(): SpawnHarness {
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild();
    children.push(child);
    calls.push({ command, args, cwd: String(options.cwd ?? "") });
    return child;
  };
  return { spawn, children, calls };
}

function makeLlm(harness: SpawnHarness, logs: LogRecord[] = []) {
  return createCommandCodeLlm({
    model: "deepseek/deepseek-v4-flash",
    prompt: PROMPT,
    spawn: harness.spawn,
    makeCwd: () => Promise.resolve("/tmp/mira-fake-cwd"),
    cleanupCwd: false,
    log: (record) => logs.push(record),
  });
}

async function collect(llm: ReturnType<typeof createCommandCodeLlm>, signal: AbortSignal): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const beat of llm.streamBeats(context(), signal)) out.push(beat);
  return out;
}

/** 让适配器跑过 `await makeCwd()`，spawn 已经调用。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Command Code 适配器（S6a §2 · 假 spawn）", () => {
  it("请求参数：cmd -p <prompt> -m <model> + 固定参数，stdin 关闭、cwd 是空的临时目录", async () => {
    const harness = makeSpawn();
    const llm = makeLlm(harness);
    const iterator = llm.streamBeats(context("你在等谁？"), new AbortController().signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    // 适配器会先 await makeCwd()，spawn 在下一个微任务里发生。
    await Promise.resolve();
    await Promise.resolve();

    const call = harness.calls[0];
    expect(call?.command).toBe("cmd");
    expect(call?.args.slice(0, 4)).toEqual(["-p", expect.any(String), "-m", "deepseek/deepseek-v4-flash"]);
    expect(call?.args.slice(4)).toEqual([...CMD_ARGS]);
    expect(call?.args[1]).toContain("动态 你在等谁？");
    expect(call?.cwd).toBe("/tmp/mira-fake-cwd");

    const child = harness.children[0];
    child?.push(textDelta('{"say":"好"}\n') + line({ type: "result", subtype: "success", usage: { inputTokens: 1 } }));
    child?.end(0);

    const first = await pending;
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ say: "好" });
    const second = await iterator.next();
    expect(second.done).toBe(true);
  });

  it("beat 流式产出：多个 text_delta 顺序拼接成多行 beat", async () => {
    const harness = makeSpawn();
    const llm = makeLlm(harness);
    const pending = collect(llm, new AbortController().signal);
    await flush();

    const child = harness.children[0];
    child?.push(textDelta('{"say":"雨还在'));
    child?.push(textDelta('下。","emotion":"calm"}\n'));
    child?.push(textDelta('{"say":"先坐吧。"}\n'));
    child?.push(line({ type: "result", subtype: "success" }));
    child?.end(0);

    expect(await pending).toEqual([
      { say: "雨还在下。", emotion: "calm" },
      { say: "先坐吧。" },
    ]);
  });

  it("坏行降级：写入日志，不影响其它 beat", async () => {
    const harness = makeSpawn();
    const logs: LogRecord[] = [];
    const llm = makeLlm(harness, logs);
    const pending = collect(llm, new AbortController().signal);
    await flush();

    const child = harness.children[0];
    child?.push(textDelta('{"say":"好"}\n{"坏行\n'));
    child?.push(line({ type: "result", subtype: "success" }));
    child?.end(0);

    const beats = await pending;
    expect(beats.length).toBeGreaterThan(0);
    expect(logs.some((record) => record.event === "llm_beat_warning")).toBe(true);
  });

  it("非零退出码 → 抛错（走现有 turn_failed）", async () => {
    const harness = makeSpawn();
    const llm = makeLlm(harness);
    const pending = collect(llm, new AbortController().signal);
    await flush();

    const child = harness.children[0];
    child?.push(textDelta('{"say":"好"}\n'));
    child?.end(1);

    await expect(pending).rejects.toThrow(/非零退出码/);
  });

  it("result.subtype 不是 success → 抛错", async () => {
    const harness = makeSpawn();
    const llm = makeLlm(harness);
    const pending = collect(llm, new AbortController().signal);
    await flush();

    const child = harness.children[0];
    child?.push(line({ type: "result", subtype: "error_max_turns" }));
    child?.end(0);

    await expect(pending).rejects.toThrow(/error_max_turns/);
  });

  it("没有 result 行 → 抛错", async () => {
    const harness = makeSpawn();
    const llm = makeLlm(harness);
    const pending = collect(llm, new AbortController().signal);
    await flush();

    const child = harness.children[0];
    child?.push(textDelta('{"say":"好"}\n'));
    child?.end(0);

    await expect(pending).rejects.toThrow(/result/);
  });

  it("中止：调用 kill 且迭代器立即结束", async () => {
    const harness = makeSpawn();
    const llm = makeLlm(harness);
    const controller = new AbortController();
    const iterator = llm.streamBeats(context(), controller.signal)[Symbol.asyncIterator]();

    const firstPending = iterator.next();
    await flush();
    const child = harness.children[0];
    child?.push(textDelta('{"say":"一"}\n'));
    const first = await firstPending;
    expect(first.value).toEqual({ say: "一" });

    controller.abort();
    const second = await iterator.next();
    expect(second.done).toBe(true);
    expect(child?.killed).toBe("SIGTERM");
  });

  it("记录 prompt_version 与 usage（只记数字）", async () => {
    const harness = makeSpawn();
    const logs: LogRecord[] = [];
    const llm = makeLlm(harness, logs);
    const pending = collect(llm, new AbortController().signal);
    await flush();

    const child = harness.children[0];
    child?.push(textDelta('{"say":"好"}\n'));
    child?.push(line({ type: "result", subtype: "success", usage: { inputTokens: 10, outputTokens: 3 } }));
    child?.end(0);
    await pending;

    expect(logs.find((record) => record.event === "prompt_version")?.detail).toEqual({ prompt_version: "rin.test" });
    const usage = logs.find((record) => record.event === "llm_usage");
    expect(usage?.detail).toMatchObject({ inputTokens: 10, outputTokens: 3 });
  });
});
