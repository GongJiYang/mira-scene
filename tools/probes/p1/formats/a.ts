import { LING_PERSONA, ACTION_MENU, EMOTION_MENU, STORY_MENU, renderScene } from "../persona";
import { judgeUnit, type BeatUnit } from "../beat";
import type { CallMetrics, FormatRequest } from "../types";
import { runTextFormat, type IncrementalParser } from "../textRunner";

/** 静态前缀：人设 + 本格式规则 + 固定示例（逐字不变，便于命中前缀缓存）。 */
const SYSTEM = `${LING_PERSONA}

【输出格式：逐行 JSON】
每行只输出一个 JSON 对象，字段固定为：
{"say":"台词","emotion":"<情绪>","suggest":"<动作或 null>","advance":"<剧情节点或 null>"}
规则：
1. 一行一个对象；不要空行，不要 Markdown 代码块，不要任何解释或前后缀。
2. emotion 只能取 ${EMOTION_MENU}。
3. suggest 只能取 ${ACTION_MENU} 或 null；advance 只能取 ${STORY_MENU} 或 null。
4. say 一律中文，每句不超过 20 个字。要做无声动作时输出 "say":"" 的行。
5. 先输出第一句，再输出第二句；一次最多两个 say。

示例输入：听众说「你好呀」
示例输出：
{"say":"雨还在下。","emotion":"calm","suggest":null,"advance":null}
{"say":"先坐吧，靠窗那桌干净。","emotion":"calm","suggest":null,"advance":"probe"}`;

function createParser(push: (unit: BeatUnit) => void): IncrementalParser {
  let buffer = "";
  const consume = (line: string, atMs: number): void => {
    const body = line.trim().replace(/^```(?:json)?/i, "").trim();
    if (body === "" || body.startsWith("```")) return;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    push(judgeUnit(atMs, body, parsed));
  };

  return {
    feed(chunk, atMs) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consume(line, atMs);
        newline = buffer.indexOf("\n");
      }
    },
    flush(atMs) {
      if (buffer.trim() !== "") consume(buffer, atMs);
      buffer = "";
    },
  };
}

export async function runA(request: FormatRequest): Promise<CallMetrics> {
  return runTextFormat({
    format: "a",
    request,
    system: SYSTEM,
    user: renderScene(request.scene, request.input.text),
    createParser,
  });
}
