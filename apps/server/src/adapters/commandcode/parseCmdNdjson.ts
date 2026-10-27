/**
 * `parseCmdNdjson`：增量解析 `cmd --output-format json` 的 NDJSON 输出（S6a §2）。
 *
 * 实测输出（每行一个 JSON 对象）：
 *   {"type":"event","event":{"type":"text_delta","delta":"…"}}
 *   …
 *   {"type":"result","subtype":"success","durationMs":2597,"usage":{…}}
 *
 * 契约：
 * - 只产出 `text_delta` 的文本增量；
 * - `result.subtype !== "success"` → 报错；
 * - 出现错误事件（`event.type === "error"` 或顶层 `type === "error"`）→ 报错；
 * - 坏行（不是合法 JSON）→ 忽略；
 * - 不做 I/O，永不抛错（错误通过返回值表达）。
 *
 * 调用方把拼好的文本交给现有的 `parseBeatLines` 产出 beat（与 DeepSeek 适配器同一路径）。
 */

export type CmdNdjsonResult = {
  /** 本批新增的文本增量（按行顺序拼接）。 */
  text: string;
  /** 还没以换行结尾的尾巴，交给下一次继续拼接。 */
  carry: string;
  /** 解析到的错误（`result.subtype !== "success"` 或错误事件）；无错误为 null。 */
  error: string | null;
  /** 是否已经收到 result 行（流可正常结束）。 */
  done: boolean;
  /** usage（只记数字；无则 null）。 */
  usage: Record<string, number> | null;
};

function emptyResult(carry: string): CmdNdjsonResult {
  return { text: "", carry, error: null, done: false, usage: null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 从 usage 里只取数字字段。 */
function readUsage(usage: unknown): Record<string, number> | null {
  const record = asRecord(usage);
  if (record === null) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

/** 解析单行，把文本 / 错误 / done / usage 累积进结果。 */
function handleLine(line: string, acc: CmdNdjsonResult): void {
  const trimmed = line.trim();
  if (trimmed === "") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return; // 坏行忽略。
  }
  const record = asRecord(parsed);
  if (record === null) return;

  const type = record.type;

  // 错误事件：顶层 type === "error"。
  if (type === "error") {
    if (acc.error === null) {
      const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
      acc.error = message;
    }
    return;
  }

  if (type === "event") {
    const event = asRecord(record.event);
    if (event === null) return;
    const eventType = event.type;
    if (eventType === "text_delta" && typeof event.delta === "string") {
      acc.text += event.delta;
      return;
    }
    if (eventType === "error") {
      if (acc.error === null) {
        const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
        acc.error = message;
      }
      return;
    }
    return;
  }

  // 结果行：subtype 不是 success 就报错。
  if (type === "result") {
    acc.done = true;
    acc.usage = readUsage(record.usage) ?? acc.usage;
    if (record.subtype !== "success") {
      const message = typeof record.subtype === "string" ? record.subtype : JSON.stringify(record);
      if (acc.error === null) acc.error = `cmd result: ${message}`;
    }
  }
}

/**
 * 处理一段增量：解析 `carry + chunk` 里所有以换行结尾的行，未结束的尾巴留在 `carry`。
 * 流结束时用 `parseCmdNdjson("\n", carry)` 冲掉最后一行。
 */
export function parseCmdNdjson(chunk: string, carry: string): CmdNdjsonResult {
  const acc = emptyResult(carry);
  const buffer = carry + chunk;
  const lines = buffer.split("\n");
  // 最后一段可能是未结束的尾巴。
  const tail = lines.pop() ?? "";
  for (const line of lines) handleLine(line, acc);
  acc.carry = tail;
  return acc;
}
