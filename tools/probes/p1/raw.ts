import { redact } from "../shared/env";
import type { FormatRequest, StreamOutcome } from "./types";

export type AbortTracker = { requestedAt: number | null };

export type RawStreamOptions = {
  request: FormatRequest;
  system: string;
  user: string;
  controller: AbortController;
  tracker: AbortTracker;
  /** 每收到一段 content delta 调用，参数是流内时间（ms）。 */
  onDelta: (chunk: string, atMs: number) => void;
  extraHeaders?: Record<string, string>;
};

const IDLE_TIMEOUT_MS = 30_000;

/**
 * 裸 SSE 流式调用（格式 a / e 用）：逐块回调，记录 usage 与取消耗时。
 * 关闭思考模式；请求体字段与 AI SDK 路径保持一致，便于公平比较。
 */
export async function streamChatRaw(options: RawStreamOptions): Promise<StreamOutcome> {
  const { request, controller, tracker } = options;
  const started = performance.now();
  const timeout = AbortSignal.timeout(IDLE_TIMEOUT_MS);
  const signal = AbortSignal.any([controller.signal, timeout]);

  const outcome: StreamOutcome = {
    text: "",
    usage: null,
    aborted: false,
    abortToCloseMs: null,
    httpStatus: null,
    error: null,
  };

  const closeOf = (error: unknown): void => {
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      outcome.aborted = name === "AbortError";
      outcome.error = name === "TimeoutError" ? `流在 ${IDLE_TIMEOUT_MS}ms 内没有结束` : null;
      if (tracker.requestedAt !== null) {
        outcome.abortToCloseMs = performance.now() - tracker.requestedAt;
      }
      return;
    }
    outcome.error = redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  };

  try {
    const response = await fetch(`${request.config.deepseek.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.config.deepseek.apiKey}`,
        accept: "text/event-stream",
        ...options.extraHeaders,
      },
      body: JSON.stringify({
        model: request.config.deepseek.model,
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.user },
        ],
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: "disabled" },
        temperature: 0.7,
        max_tokens: 600,
      }),
    });
    outcome.httpStatus = response.status;

    if (!response.ok || response.body === null) {
      const body = await response.text().catch(() => "");
      outcome.error = redact(`HTTP ${response.status} ${body.slice(0, 400)}`);
      return outcome;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const atMs = performance.now() - started;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
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
          if (chunk.usage && typeof chunk.usage === "object") {
            outcome.usage = chunk.usage as Record<string, unknown>;
          }
          const choices = chunk.choices;
          if (!Array.isArray(choices) || choices.length === 0) continue;
          const first = choices[0] as { delta?: { content?: unknown } } | undefined;
          const content = first?.delta?.content;
          if (typeof content === "string" && content !== "") {
            outcome.text += content;
            options.onDelta(content, atMs);
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch (error) {
    closeOf(error);
  }

  return outcome;
}
