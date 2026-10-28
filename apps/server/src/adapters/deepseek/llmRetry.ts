/**
 * §3：LLM 网络抖动的重试判定（纯函数）。
 *
 * 只在**还没收到任何 token** 时对「网络类」错误重试一次：
 * - `fetch failed`（Node/undici 在连接层失败时抛的 `TypeError`，原因在 `cause.code`）；
 * - `ECONNRESET` / `ETIMEDOUT` / `ECONNREFUSED` 等连接错误码；
 * - HTTP 5xx（服务端临时故障）。
 *
 * 明确**不重试**：HTTP 4xx（多为鉴权 / 请求非法，重试无意义）、AbortError（中止 / 超时）。
 */
import { isAbortError } from "../../abort";

/** 连接层错误码（出现即视为可重试的网络抖动）。 */
const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENOTFOUND"]);

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  const code = record.code;
  if (typeof code === "string") return code;
  const cause = record.cause;
  if (typeof cause === "object" && cause !== null) {
    const causeCode = (cause as Record<string, unknown>).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return null;
}

/**
 * 判断一个由 `doFetch` 抛出的错误是否属于「可重试的网络抖动」。
 * 4xx / AbortError 一律 false。
 */
export function isRetryableLlmNetworkError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const code = codeOf(error);
  if (code !== null && RETRYABLE_CODES.has(code)) return true;
  if (error instanceof Error) {
    const message = error.message;
    if (message.includes("fetch failed") || message.includes("ECONNRESET") || message.includes("ETIMEDOUT")) {
      return true;
    }
  }
  return false;
}

/** 判断一个 HTTP 状态码是否可重试（仅 5xx）。 */
export function isRetryableLlmStatus(status: number): boolean {
  return status >= 500 && status < 600;
}
