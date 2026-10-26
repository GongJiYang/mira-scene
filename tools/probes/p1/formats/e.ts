import { judgeUnit, type BeatUnit } from "../beat";
import type { CallMetrics, FormatRequest } from "../types";
import { runTextFormat, type IncrementalParser } from "../textRunner";
import { LING_PERSONA, ACTION_MENU, EMOTION_MENU, STORY_MENU, renderScene } from "../persona";

/** 静态前缀：人设 + 行内标签规则 + 固定示例。 */
const SYSTEM = `${LING_PERSONA}

【输出格式：行内标签】
每句以情绪标签开头，台词在前，可选标签写在句末：
[emotion]台词<act:动作><advance:剧情节点>
规则：
1. 不要输出解释、编号、Markdown，也不要用 JSON。
2. emotion 只能取 ${EMOTION_MENU}，写成 [calm] 这种方括号形式，放在句子最前面。
3. 句末可加 <act:${ACTION_MENU}> 与 <advance:${STORY_MENU}>，不需要就省略。
4. 一句一行，用句号结尾；每句不超过 20 个字，一次一到两句。

示例输入：听众说「你好呀」
示例输出：
[calm]雨还在下。<act:glance_window>
[calm]先坐吧，靠窗那桌干净。<advance:probe>`;

const LINE_TAG = /^\s*\[([^\]]+)\]\s*/;
const INLINE_TAG = /<(act|advance):([a-z_]+)>/g;

const TERMINATORS = new Set(["。", "！", "？", "!", "?", "\n"]);

/**
 * 把一段（按句号切出来的）文本拆成 llmBeat 形状。
 * 纯标签片段（句号之后的 <act:…>）返回 `fragment`，由调用方补给上一句。
 */
function parseSegment(
  segment: string,
  inherited: string | null,
): { raw: Record<string, unknown>; tag: string | null; fragment: boolean } {
  const stripped = segment.trim();
  const tagMatch = LINE_TAG.exec(stripped);
  const tag = tagMatch ? (tagMatch[1] ?? null) : null;
  const body = tagMatch ? stripped.slice(tagMatch[0].length) : stripped;

  let suggest: string | null = null;
  let advance: string | null = null;
  const text = body.replace(INLINE_TAG, (_match, kind: string, value: string) => {
    if (kind === "act") suggest = value;
    else advance = value;
    return "";
  });

  const say = text.replace(/[。！？!?\s]+$/, "").trim();
  const fragment = say === "" && tag === null;
  return { raw: { say, emotion: tag ?? inherited ?? "", suggest, advance }, tag, fragment };
}

function createParser(push: (unit: BeatUnit) => void): IncrementalParser {
  let buffer = "";
  let inherited: string | null = null;
  let last: BeatUnit | null = null;
  let lastRaw: Record<string, unknown> | null = null;

  const consume = (segment: string, atMs: number): void => {
    if (segment.trim() === "") return;
    const { raw, tag, fragment } = parseSegment(segment, inherited);

    // 句号之后单独出现的 <act:…> / <advance:…>：补给上一句（同一 beat）。
    if (fragment) {
      if (last !== null && lastRaw !== null) {
        if (typeof raw.suggest === "string") lastRaw.suggest = raw.suggest;
        if (typeof raw.advance === "string") lastRaw.advance = raw.advance;
        Object.assign(last, judgeUnit(last.atMs, last.rawText, lastRaw));
      }
      return;
    }

    if (tag !== null) inherited = tag;
    const unit = judgeUnit(atMs, segment.trim(), raw);
    last = unit;
    lastRaw = raw;
    push(unit);
  };

  return {
    feed(chunk, atMs) {
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const char = buffer[i];
        if (char === undefined || !TERMINATORS.has(char)) continue;
        const end = char === "\n" ? i : i + 1;
        consume(buffer.slice(start, end), atMs);
        start = end;
      }
      buffer = buffer.slice(start);
    },
    flush(atMs) {
      if (buffer.trim() !== "") consume(buffer, atMs);
      buffer = "";
    },
  };
}

export async function runE(request: FormatRequest): Promise<CallMetrics> {
  return runTextFormat({
    format: "e",
    request,
    system: SYSTEM,
    user: renderScene(request.scene, request.input.text),
    createParser,
  });
}
