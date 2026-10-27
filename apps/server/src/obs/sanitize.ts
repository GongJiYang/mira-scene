/**
 * S6h §1：观测记录清洗（纯函数）。
 *
 * 铁律：观测数据里不得出现用户输入的文字、台词、提示词、Key。
 * 只保留 `ts / sessionId / turnId / event / ms` 和 detail 里的白名单字段，
 * 其余一律丢弃；字符串值最长 40。
 */
import type { LogRecord } from "../log";

/** detail 白名单：只收数值 / 枚举 / 布尔字段。 */
const DETAIL_WHITELIST = new Set([
  // 通用枚举 / 状态
  "code",
  "status",
  "port",
  "provider",
  "reason",
  "scope",
  "category",
  "input",
  // 数值
  "bytes",
  "limit",
  "used",
  "chars",
  "seq",
  "clientMs",
  "first_audio_ms",
  "server_ms",
  // commandcode LLM 的 usage 事件带 duration_ms（模型调用耗时，S6h §1.4）。
  "duration_ms",
  "afterBeat",
  "last",
  "incoming",
  "cps",
  // 布尔
  "silent",
  "suggestAccepted",
  "advanceAccepted",
]);

export type SanitizedRecord = {
  ts: number;
  sessionId?: string;
  turnId?: number;
  event: string;
  ms?: number;
  detail?: Record<string, string | number | boolean>;
};

const MAX_STRING_LEN = 40;

/** 把单个值压成白名单允许的形式；不允许时返回 undefined。 */
function cleanValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    // 截断到 40，超出加省略标记（仍是字符串）。
    return value.length > MAX_STRING_LEN ? `${value.slice(0, MAX_STRING_LEN)}…` : value;
  }
  return undefined;
}

/** 清洗一条日志记录；返回可安全进观测缓冲的形式。 */
export function sanitize(record: LogRecord): SanitizedRecord {
  const out: SanitizedRecord = { ts: record.ts, event: record.event };
  if (record.sessionId !== undefined) out.sessionId = record.sessionId;
  if (record.turnId !== undefined) out.turnId = record.turnId;
  if (record.ms !== undefined && Number.isFinite(record.ms)) out.ms = record.ms;

  if (record.detail !== undefined && record.detail !== null && typeof record.detail === "object" && !Array.isArray(record.detail)) {
    const cleaned: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(record.detail as Record<string, unknown>)) {
      if (!DETAIL_WHITELIST.has(key)) continue;
      const v = cleanValue(value);
      if (v !== undefined) cleaned[key] = v;
    }
    if (Object.keys(cleaned).length > 0) out.detail = cleaned;
  }
  return out;
}
