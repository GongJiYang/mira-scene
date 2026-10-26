import type { LlmBeat } from "@mira/protocol";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, streamObject } from "ai";
import { ACTIONS, EMOTIONS, STORY_NODES, judgeUnit, sayLength, type BeatUnit } from "../beat";
import type { CallMetrics, FormatRequest } from "../types";
import { readCache } from "../textRunner";
import { redact } from "../../shared/env";
import { LING_PERSONA, ACTION_MENU, EMOTION_MENU, STORY_MENU, renderScene } from "../persona";

/** 静态前缀：人设 + JSON 数组规则 + 固定示例。 */
const SYSTEM = `${LING_PERSONA}

【输出格式：JSON 数组】
只输出一个 JSON 数组，元素是 beat 对象：
[{"say":"台词","emotion":"calm","suggest":null,"advance":null}]
规则：
1. 除了这个数组，什么都不要输出（不要 Markdown 代码块，不要解释）。
2. emotion 只能取 ${EMOTION_MENU}；suggest 取 ${ACTION_MENU} 或 null；advance 取 ${STORY_MENU} 或 null。
3. say 一律中文，每句不超过 20 个字；无声动作用 "say":""。
4. 数组里先放第一句，再放第二句，最多三个元素。

示例输入：听众说「你好呀」
示例输出：
[{"say":"雨还在下。","emotion":"calm","suggest":null,"advance":null},{"say":"先坐吧，靠窗那桌干净。","emotion":"calm","suggest":null,"advance":"probe"}]`;

/** LlmBeat 数组的 JSON Schema（与 packages/protocol 的 llmBeatSchema 同形）。 */
const BEATS_SCHEMA = jsonSchema<LlmBeat[]>({
  type: "array",
  items: {
    type: "object",
    properties: {
      say: { type: "string" },
      emotion: { type: "string", enum: [...EMOTIONS] },
      suggest: { anyOf: [{ type: "string", enum: [...ACTIONS] }, { type: "null" }] },
      advance: { anyOf: [{ type: "string", enum: [...STORY_NODES] }, { type: "null" }] },
    },
    required: ["say", "emotion"],
    additionalProperties: false,
  },
});

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export async function runB(request: FormatRequest): Promise<CallMetrics> {
  const provider = createOpenAICompatible({
    name: "deepseek",
    baseURL: request.config.deepseek.baseUrl,
    apiKey: request.config.deepseek.apiKey,
    includeUsage: true,
    headers: { "x-probe-format": "b" },
  });

  const controller = new AbortController();
  const started = performance.now();
  let firstValidAtMs: number | null = null;
  let abortRequestedAt: number | null = null;
  let lastPartial: unknown[] = [];
  let errorText: string | null = null;
  let aborted = false;

  const result = streamObject({
    model: provider(request.config.deepseek.model),
    schema: BEATS_SCHEMA,
    system: SYSTEM,
    prompt: renderScene(request.scene, request.input.text),
    abortSignal: controller.signal,
    temperature: 0.7,
    maxOutputTokens: 600,
    providerOptions: { deepseek: { thinking: { type: "disabled" } } },
  });

  // 取消时 object / usage 会 reject；提前挂 catch，避免 unhandled rejection 噪音。
  void result.object.catch(() => undefined);
  void result.usage.catch(() => undefined);

  try {
    for await (const partial of result.partialObjectStream) {
      const atMs = performance.now() - started;
      const elements = asArray(partial);
      lastPartial = elements;
      elements.forEach((element) => {
        if (firstValidAtMs !== null) return;
        const unit = judgeUnit(atMs, JSON.stringify(element ?? null), element);
        if (!unit.strictValid) return;
        firstValidAtMs = atMs;
        request.onFirstBeat?.();
        if (request.abortAfterFirstBeat) {
          abortRequestedAt = performance.now() - started;
          controller.abort();
        }
      });
    }
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError") {
      aborted = true;
    } else {
      errorText = redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
  }

  const totalMs = performance.now() - started;
  const abortToCloseMs = abortRequestedAt === null ? null : totalMs - abortRequestedAt;
  const endAt = totalMs;

  // 流结束后再按最终快照判定一次（取消测试时快照可能不完整）。
  const units: BeatUnit[] = lastPartial.map((element) => judgeUnit(endAt, JSON.stringify(element ?? null), element));
  const beats = units.flatMap((unit) => (unit.beat === null ? [] : [unit.beat]));
  const first = units.find((unit) => unit.strictValid) ?? null;

  let usageRaw: unknown = null;
  let cachedInputTokens: number | null = null;
  try {
    const usage = await result.usage;
    usageRaw = usage;
    cachedInputTokens = typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : null;
  } catch {
    usageRaw = null;
  }

  return {
    format: "b",
    inputId: request.input.id,
    inputType: request.input.type,
    firstValidBeatMs: firstValidAtMs ?? first?.atMs ?? null,
    firstUnitMs: units[0]?.atMs ?? null,
    totalMs,
    units: units.length,
    strictValidUnits: units.filter((unit) => unit.strictValid).length,
    enumValidUnits: units.filter((unit) => unit.enumValid).length,
    firstSayLen: first?.beat ? sayLength(first.beat.say) : null,
    firstSayWithin20: first?.beat ? sayLength(first.beat.say) <= 20 : null,
    cache: { ...readCache(usageRaw as Record<string, unknown> | null), cachedTokens: cachedInputTokens },
    usageRaw,
    aborted,
    abortToCloseMs,
    httpStatus: null,
    error: errorText,
    rawText: JSON.stringify(lastPartial).slice(0, 4000),
    rawSamples: units.slice(0, 3).map((unit) => unit.rawText),
    beats,
  };
}
