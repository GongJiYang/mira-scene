/**
 * 逐行 JSON 增量解析器（D31 格式 a，架构关卡 §3 要求写成纯函数）。
 *
 * 输入是一段文本增量与上一次的残留（未以换行结尾的尾巴），
 * 输出完整行解析出的原始对象、新的残留与 warning。不做任何 I/O，永不抛错。
 *
 * 容错（§1）：
 * - 去掉 ``` 代码块包裹（行首/行尾的围栏）。
 * - 去掉行首行尾空白。
 * - 一行 `JSON.parse` 成功且是对象 → 直接产出；可解析但不是对象 → 沿用既有行为降级为纯台词。
 * - 一行 `JSON.parse` **失败**时（修复轮 §1），按以下顺序处理：
 *   ① 以 `{` 开头 → 按 `}{`（允许中间空白）拆开后逐段解析；
 *   ② 用正则提取 `"say"`（以及 `"emotion"`，如果有的话），得到一个 beat；
 *   ③ 看起来像 JSON（以 `{`/`[` 开头，或含 `":`）但上面都失败 → **丢弃**，只写 warning；
 *   ④ 完全不像 JSON 的纯文本 → 降级为 `{say: 行文本, emotion:"neutral"}`。
 *
 * 目的（修复轮 §1）：坏行绝不能把 `{`、`"`、`":` 这类 JSON 符号当作台词送进 TTS。
 */

export type ParsedBeatLines = {
  /** 逐行解析出的原始对象（交给会话层的 parseLlmBeatLenient 处理）。 */
  beats: unknown[];
  /** 还没有以换行结尾的尾巴，交给下一次继续拼接。 */
  carry: string;
  /** 本批产生的 warning（坏行降级/丢弃等）。 */
  warnings: string[];
};

const MAX_WARNING_TEXT = 120;

/** ② 从坏行里提取台词的正则（与 s3-fix §1 一致）。 */
const SAY_FIELD = /"say"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const EMOTION_FIELD = /"emotion"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function preview(text: string): string {
  return text.length > MAX_WARNING_TEXT ? `${text.slice(0, MAX_WARNING_TEXT)}…` : text;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 去掉一行里可能的代码块围栏与首尾空白；返回清理后的文本。 */
export function sanitizeBeatLine(rawLine: string): string {
  let line = rawLine.trim();
  line = line.replace(/^```[a-zA-Z0-9]*\s*/, "");
  line = line.replace(/```\s*$/, "");
  return line.trim();
}

/** 看起来像 JSON：以 `{` / `[` 开头，或含 `":`（③ 的判据）。 */
function looksLikeJson(line: string): boolean {
  return line.startsWith("{") || line.startsWith("[") || line.includes('":');
}

/** 把 JSON 字符串字面量内容还原成实际文本；解析失败时原样返回（不抛错）。 */
function decodeJsonString(raw: string): string {
  try {
    const value = JSON.parse(`"${raw}"`);
    return typeof value === "string" ? value : raw;
  } catch {
    return raw;
  }
}

/** ② 用正则从坏行里提取 say（以及可选的 emotion）；提取不到 say 时返回 null。 */
function extractBeat(line: string): Record<string, unknown> | null {
  const sayValue = SAY_FIELD.exec(line)?.[1];
  if (sayValue === undefined) return null;
  const emotionValue = EMOTION_FIELD.exec(line)?.[1];
  return {
    say: decodeJsonString(sayValue),
    emotion: emotionValue === undefined ? "neutral" : decodeJsonString(emotionValue),
  };
}

/** ① 把粘连的 JSON（`}{` 之间允许空白）拆成独立片段，并去掉围栏与空白、过滤空段。 */
function splitGluedJson(line: string): string[] {
  return line
    .replace(/\}\s*\{/g, "}\n{")
    .split("\n")
    .map(sanitizeBeatLine)
    .filter((segment) => segment !== "");
}

/** 顶层一行与拆分后的片段共用：先尝试整段 JSON.parse，失败再走 ①②③④。 */
function pushParsedOrResolve(line: string, beats: unknown[], warnings: string[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    resolveUnparsable(line, beats, warnings);
    return;
  }

  if (isPlainObject(parsed)) {
    beats.push(parsed);
    return;
  }
  // 可解析但不是对象（数组/原始值）：沿用既有行为，降级为纯台词。
  beats.push({ say: line, emotion: "neutral" });
  warnings.push(`非对象的 JSON 行已降级为纯台词：${preview(line)}`);
}

function resolveUnparsable(line: string, beats: unknown[], warnings: string[]): void {
  // ① 以 `{` 开头的粘连 JSON：按 `}{` 拆开后逐段解析。
  if (line.startsWith("{")) {
    const segments = splitGluedJson(line);
    if (segments.length > 1) {
      for (const segment of segments) pushParsedOrResolve(segment, beats, warnings);
      return;
    }
  }

  // ② 正则提取 say（以及 emotion）。
  const extracted = extractBeat(line);
  if (extracted !== null) {
    beats.push(extracted);
    warnings.push(`坏行已用正则提取台词：${preview(line)}`);
    return;
  }

  // ③ 看起来像 JSON 但提取不出 → 丢弃，只写 warning（不把 JSON 符号念出来）。
  if (looksLikeJson(line)) {
    warnings.push(`疑似 JSON 的坏行已丢弃：${preview(line)}`);
    return;
  }

  // ④ 完全不像 JSON 的纯文本 → 降级成台词。
  beats.push({ say: line, emotion: "neutral" });
  warnings.push(`无法解析的整行已降级为纯台词：${preview(line)}`);
}

function handleLine(rawLine: string, beats: unknown[], warnings: string[]): void {
  const line = sanitizeBeatLine(rawLine);
  if (line === "") return;
  pushParsedOrResolve(line, beats, warnings);
}

/**
 * 处理一段增量：把 `carry + chunk` 里所有以换行结尾的行解析出来，
 * 未结束的尾巴留在 `carry` 里。流结束时用 `parseBeatLines("\n", carry)` 冲掉最后一行。
 */
export function parseBeatLines(chunk: string, carry: string): ParsedBeatLines {
  const beats: unknown[] = [];
  const warnings: string[] = [];

  let buffer = carry + chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    handleLine(buffer.slice(0, newline), beats, warnings);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }

  return { beats, carry: buffer, warnings };
}
