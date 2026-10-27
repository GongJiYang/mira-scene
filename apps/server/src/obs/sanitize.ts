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
  // S6l-fix1 §0：换背景失败 / 被拒的短原因（已截断到 40；不含 Key 与完整提示词）。
  "error",
  "note",
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

/**
 * S6h §4 / D49 S6n §4：形如 Key 的字段名，其值一律替换为 `[redacted]`。
 * 新增规则：`apiKey` / `authorization` / `key`（大小写不敏感，含 kebab / snake 变体）。
 */
const SECRET_FIELD_PATTERN = /^(api[-_]?key|authorization|key|apikey|token|secret)$/i;

/**
 * S6n §4：把字符串里「形如 Key / Bearer / URL 查询参数」的片段替换为 `[redacted]`。
 * 适配器的报错信息可能回显请求头或 URL，写日志 / 下发前统一经这里过滤。
 */
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  // `Bearer <token>` / `Bearer=...`
  /bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // `key=...` / `apiKey=...` / `token=...` / `authorization=...`（URL 查询参数或键值对）
  /(api[-_]?key|authorization|token|secret|key)\s*[=:]\s*[^&\s"'`]+/gi,
  // 形如 `sk-xxxx` 的 Key 字面量
  /\bsk-[A-Za-z0-9._-]{6,}\b/g,
];

export function redactSecrets(text: string, replacement = "[redacted]"): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

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
      // S6n §4：形如 Key 的字段名即使进了白名单，其值也一律脱敏。
      if (SECRET_FIELD_PATTERN.test(key)) {
        cleaned[key] = "[redacted]";
        continue;
      }
      if (!DETAIL_WHITELIST.has(key)) continue;
      const v = cleanValue(value);
      if (v !== undefined) cleaned[key] = v;
    }
    if (Object.keys(cleaned).length > 0) out.detail = cleaned;
  }
  return out;
}
