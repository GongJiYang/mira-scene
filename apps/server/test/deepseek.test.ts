import { describe, expect, it } from "vitest";
import { createDeepSeekLlm } from "../src/adapters/deepseek/deepseekLlm";
import type { LogRecord } from "../src/log";
import type { LLMContext } from "../src/ports";
import type { PromptPack } from "../src/prompts/renderPrompt";
import { createInitialScene } from "../src/story";
import { testPack } from "./helpers/pack";

const PROMPT: PromptPack = {
  ...testPack("yuna"),
  promptVersion: "yuna.test",
  staticText: "静态前缀",
  dynamicTemplate: "动态 {{user_text}}",
};

function context(userText = "你好"): LLMContext {
  return { history: [], scene: createInitialScene(), userText, pack: PROMPT };
}

function dataChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

function usageChunk(usage: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [], usage })}\n\n`;
}

function sse(parts: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function openSse(parts: readonly string[], signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      signal?.addEventListener("abort", () => {
        try {
          controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        } catch {
          // 已经关闭/报错，忽略。
        }
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: FetchHandler, calls: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return handler(url, requestInit);
  }) as unknown as typeof fetch;
}

function makeLlm(fetchImpl: typeof fetch, logs: LogRecord[] = []) {
  return createDeepSeekLlm({
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "test-key",
    model: "deepseek-chat",
    fetch: fetchImpl,
    log: (record) => logs.push(record),
  });
}

async function collect(
  llm: ReturnType<typeof createDeepSeekLlm>,
  ctx: LLMContext,
  signal: AbortSignal,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const beat of llm.streamBeats(ctx, signal)) out.push(beat);
  return out;
}

describe("DeepSeek 适配器（§1 / 格式 a）", () => {
  it("请求体与提示词：system=STATIC，user=动态后缀填充", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const llm = makeLlm(
      fakeFetch(() => sse([dataChunk('{"say":"好"}\n'), "data: [DONE]\n\n"]), calls),
    );
    const beats = await collect(llm, context("你在等谁？"), new AbortController().signal);
    expect(beats).toEqual([{ say: "好" }]);

    const call = calls[0];
    expect(call?.url).toBe("https://api.deepseek.com/v1/chat/completions");
    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.stream_options).toEqual({ include_usage: true });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: "静态前缀" });
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("动态 你在等谁？");
  });

  it("正常多行 + 跨块的行缓冲", async () => {
    const llm = makeLlm(
      fakeFetch(() =>
        sse([
          dataChunk('{"say":"雨还在下。"'),
          dataChunk(',"emotion":"calm"}\n{"say":"先坐吧。","emotion":"calm"}\n'),
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const beats = await collect(llm, context(), new AbortController().signal);
    expect(beats).toEqual([
      { say: "雨还在下。", emotion: "calm" },
      { say: "先坐吧。", emotion: "calm" },
    ]);
  });

  it("代码块包裹（```json / ```）被去掉", async () => {
    const llm = makeLlm(
      fakeFetch(() =>
        sse([dataChunk("```json\n"), dataChunk('{"say":"好","emotion":"warm"}\n'), dataChunk("```\n"), "data: [DONE]\n\n"]),
      ),
    );
    const beats = await collect(llm, context(), new AbortController().signal);
    expect(beats).toEqual([{ say: "好", emotion: "warm" }]);
  });

  it("坏行降级为纯台词并写 warning", async () => {
    const logs: LogRecord[] = [];
    const llm = makeLlm(
      fakeFetch(() => sse([dataChunk("这不是 JSON\n"), dataChunk('{"say":"好的"}\n'), "data: [DONE]\n\n"])),
      logs,
    );
    const beats = await collect(llm, context(), new AbortController().signal);
    expect(beats).toEqual([{ say: "这不是 JSON", emotion: "neutral" }, { say: "好的" }]);
    expect(logs.some((record) => record.event === "llm_beat_warning")).toBe(true);
  });

  it("末尾没有换行的尾巴在流结束时被冲掉", async () => {
    const llm = makeLlm(
      fakeFetch(() => sse([dataChunk('{"say":"最后一句","emotion":"sad"}'), "data: [DONE]\n\n"])),
    );
    const beats = await collect(llm, context(), new AbortController().signal);
    expect(beats).toEqual([{ say: "最后一句", emotion: "sad" }]);
  });

  it("usage 的缓存命中字段写入日志", async () => {
    const logs: LogRecord[] = [];
    const llm = makeLlm(
      fakeFetch(() =>
        sse([
          dataChunk('{"say":"好"}\n'),
          usageChunk({ prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } }),
          "data: [DONE]\n\n",
        ]),
      ),
      logs,
    );
    await collect(llm, context(), new AbortController().signal);
    const usage = logs.find((record) => record.event === "llm_usage");
    expect(usage?.detail).toMatchObject({ prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, cached_tokens: 80 });
  });

  it("每一轮流式调用的开头记录 prompt_version", async () => {
    const logs: LogRecord[] = [];
    const llm = makeLlm(fakeFetch(() => sse([dataChunk('{"say":"好"}\n'), "data: [DONE]\n\n"])), logs);
    await collect(llm, context(), new AbortController().signal);
    expect(logs.find((record) => record.event === "prompt_version")?.detail).toEqual({ prompt_version: "yuna.test" });
  });

  it("中途 abort → 迭代器立即结束，不再产出", async () => {
    const controller = new AbortController();
    const llm = makeLlm(fakeFetch(() => openSse([dataChunk('{"say":"一"}\n')], controller.signal)));
    const iterator = llm.streamBeats(context(), controller.signal)[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ say: "一" });

    controller.abort();
    const second = await iterator.next();
    expect(second.done).toBe(true);
  });
});

describe("§3 LLM 网络抖动重试（未出 token 时重试 1 次）", () => {
  it("首 token 前 fetch failed → 重试 1 次，本轮正常完成，日志含 llm_retry", async () => {
    const logs: LogRecord[] = [];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let n = 0;
    const llm = makeLlm(
      fakeFetch(() => {
        const call = n++;
        if (call === 0) throw new TypeError("fetch failed");
        return sse([dataChunk('{"say":"好"}\n'), "data: [DONE]\n\n"]);
      }, calls),
      logs,
    );
    const beats = await collect(llm, context(), new AbortController().signal);
    expect(beats).toEqual([{ say: "好" }]);
    expect(calls.length).toBe(2);
    expect(logs.some((record) => record.event === "llm_retry")).toBe(true);
  });

  it("4xx（HTTP 401）→ 不重试", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const llm = makeLlm(fakeFetch(() => new Response("unauthorized", { status: 401 }), calls));
    await expect(collect(llm, context(), new AbortController().signal)).rejects.toThrow(/401/);
    expect(calls.length).toBe(1);
  });

  it("5xx（HTTP 500）首 token 前 → 重试 1 次", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let n = 0;
    const llm = makeLlm(
      fakeFetch(() => {
        const call = n++;
        return call === 0 ? new Response("boom", { status: 500 }) : sse([dataChunk('{"say":"好"}\n'), "data: [DONE]\n\n"]);
      }, calls),
    );
    const beats = await collect(llm, context(), new AbortController().signal);
    expect(beats).toEqual([{ say: "好" }]);
    expect(calls.length).toBe(2);
  });

  it("abort → 不重试（静默结束）", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const llm = makeLlm(
      fakeFetch(() => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }, calls),
    );
    const beats = await collect(llm, context(), controller.signal);
    expect(beats).toEqual([]);
    expect(calls.length).toBe(1);
  });

  it("已出 token 后网络错误 → 不重试", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const llm = makeLlm(
      fakeFetch(() => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(dataChunk('{"say":"一"}\n')));
            controller.error(new TypeError("fetch failed"));
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }, calls),
    );
    await expect(collect(llm, context(), new AbortController().signal)).rejects.toThrow(/fetch failed/);
    expect(calls.length).toBe(1);
  });
});
