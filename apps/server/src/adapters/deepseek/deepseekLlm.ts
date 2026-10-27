/**
 * DeepSeek 适配器（D31 格式 a · 逐行 JSON 流式）。
 *
 * - OpenAI 兼容流式接口：`POST {baseUrl}/chat/completions`，字段与仓库内 P1 探针一致
 *   （tools/probes/p1/raw.ts）：`stream`、`stream_options.include_usage`、`thinking:{type:"disabled"}`。
 * - 提示词由 `renderPrompt` 从静态前缀 + 动态后缀渲染（适配器只是一层薄壳）。
 * - 增量解析交给纯函数 `parseBeatLines`；坏行降级为纯台词。
 * - usage 里与缓存命中相关的字段写入日志。
 * - AbortSignal 直接透传给 fetch，中止后迭代器立即结束。
 */
import type { Logger } from "../../log";
import type { LLMContext, LLMPort } from "../../ports";
import { isAbortError } from "../../abort";
import { renderPrompt, type ChatMessage } from "../../prompts/renderPrompt";
import { parseBeatLines } from "./parseBeatLines";

export type DeepSeekLlmOptions = {
  /** 例如 `https://api.deepseek.com/v1`。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  log?: Logger;
  temperature?: number;
  maxTokens?: number;
};

type UsageLike = Record<string, unknown>;

function readCacheDetail(usage: UsageLike): Record<string, unknown> {
  const details = usage.prompt_tokens_details;
  const cached =
    details !== null && typeof details === "object" ? (details as Record<string, unknown>).cached_tokens : undefined;
  return {
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens ?? null,
    prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens ?? null,
    cached_tokens: cached ?? null,
  };
}

export function createDeepSeekLlm(options: DeepSeekLlmOptions): LLMPort {
  const doFetch = options.fetch ?? globalThis.fetch;
  const temperature = options.temperature ?? 0.7;
  const maxTokens = options.maxTokens ?? 600;

  return {
    async *streamBeats(ctx: LLMContext, signal): AsyncIterable<unknown> {
      const messages: ChatMessage[] = renderPrompt(ctx.pack, ctx);

      options.log?.({
        ts: Date.now(),
        event: "prompt_version",
        detail: { prompt_version: ctx.pack.promptVersion },
      });

      let response: Response;
      try {
        response = await doFetch(`${options.baseUrl}/chat/completions`, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
            accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: options.model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            thinking: { type: "disabled" },
            temperature,
            max_tokens: maxTokens,
          }),
        });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        throw error;
      }

      if (!response.ok || response.body === null) {
        const detail = await response.text().catch(() => "");
        throw new Error(`DeepSeek 返回 ${response.status} ${detail.slice(0, 200)}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let carry = "";

      const emit = function* (chunk: string): Generator<unknown> {
        const parsed = parseBeatLines(chunk, carry);
        carry = parsed.carry;
        for (const warning of parsed.warnings) {
          options.log?.({ ts: Date.now(), event: "llm_beat_warning", detail: { warning } });
        }
        yield* parsed.beats;
      };

      try {
        while (!signal.aborted) {
          let read: Awaited<ReturnType<typeof reader.read>>;
          try {
            read = await reader.read();
          } catch (error) {
            if (signal.aborted || isAbortError(error)) break;
            throw error;
          }
          if (read.done) break;

          sseBuffer += decoder.decode(read.value, { stream: true });

          let newline = sseBuffer.indexOf("\n");
          while (newline >= 0) {
            const line = sseBuffer.slice(0, newline).trim();
            sseBuffer = sseBuffer.slice(newline + 1);
            newline = sseBuffer.indexOf("\n");

            if (line === "" || line.startsWith(":")) continue;
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;

            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue;
            }

            const usage = chunk.usage;
            if (usage !== null && typeof usage === "object") {
              options.log?.({ ts: Date.now(), event: "llm_usage", detail: readCacheDetail(usage as UsageLike) });
            }

            const choices = chunk.choices;
            if (!Array.isArray(choices) || choices.length === 0) continue;
            const first = choices[0] as { delta?: { content?: unknown } } | undefined;
            const content = first?.delta?.content;
            if (typeof content === "string" && content !== "") {
              yield* emit(content);
            }
          }
        }

        // 流结束：冲掉最后一行没带换行的尾巴。
        if (!signal.aborted) {
          const flushed = parseBeatLines("\n", carry);
          for (const warning of flushed.warnings) {
            options.log?.({ ts: Date.now(), event: "llm_beat_warning", detail: { warning } });
          }
          yield* flushed.beats;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}
