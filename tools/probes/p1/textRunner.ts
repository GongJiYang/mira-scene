import { sayLength, type BeatUnit } from "./beat";
import type { CallMetrics, CacheInfo, FormatId, FormatRequest, StreamOutcome } from "./types";
import { createSink } from "./types";
import { streamChatRaw, type AbortTracker } from "./raw";

export type IncrementalParser = {
  feed: (chunk: string, atMs: number) => void;
  /** 流结束时把没带终止符的尾巴也算一个单元。 */
  flush: (atMs: number) => void;
};

/** a / e 两种文本格式共用：流式增量解析 + 指标汇总。 */
export async function runTextFormat(options: {
  format: FormatId;
  request: FormatRequest;
  system: string;
  user: string;
  createParser: (push: (unit: BeatUnit) => void) => IncrementalParser;
}): Promise<CallMetrics> {
  const { request } = options;
  const controller = new AbortController();
  const tracker: AbortTracker = { requestedAt: null };
  const sink = createSink(() => {
    tracker.requestedAt = performance.now();
    controller.abort();
  }, request);
  const parser = options.createParser((unit) => sink.push(unit));
  const started = performance.now();

  const outcome: StreamOutcome = await streamChatRaw({
    request,
    system: options.system,
    user: options.user,
    controller,
    tracker,
    extraHeaders: { "x-probe-format": options.format },
    onDelta: (chunk, atMs) => parser.feed(chunk, atMs),
  });
  parser.flush(performance.now() - started);

  const units = sink.units;
  const first = units.find((unit) => unit.strictValid) ?? null;
  const beats = units.flatMap((unit) => (unit.beat === null ? [] : [unit.beat]));

  return {
    format: options.format,
    inputId: request.input.id,
    inputType: request.input.type,
    firstValidBeatMs: first?.atMs ?? null,
    firstUnitMs: units[0]?.atMs ?? null,
    totalMs: performance.now() - started,
    units: units.length,
    strictValidUnits: units.filter((unit) => unit.strictValid).length,
    enumValidUnits: units.filter((unit) => unit.enumValid).length,
    firstSayLen: first?.beat ? sayLength(first.beat.say) : null,
    firstSayWithin20: first?.beat ? sayLength(first.beat.say) <= 20 : null,
    cache: readCache(outcome.usage),
    usageRaw: outcome.usage,
    aborted: outcome.aborted,
    abortToCloseMs: outcome.abortToCloseMs,
    httpStatus: outcome.httpStatus,
    error: outcome.error,
    rawText: outcome.text.slice(0, 4000),
    rawSamples: units.slice(0, 3).map((unit) => unit.rawText),
    beats,
  };
}

/** 从 DeepSeek 的 usage 里读前缀缓存字段（两种字段名都读）。 */
export function readCache(usage: Record<string, unknown> | null | undefined): CacheInfo {
  if (!usage) return { hitTokens: null, missTokens: null, cachedTokens: null };
  const details = usage.prompt_tokens_details;
  const cached = details && typeof details === "object" ? (details as Record<string, unknown>).cached_tokens : undefined;
  return {
    hitTokens: typeof usage.prompt_cache_hit_tokens === "number" ? usage.prompt_cache_hit_tokens : null,
    missTokens: typeof usage.prompt_cache_miss_tokens === "number" ? usage.prompt_cache_miss_tokens : null,
    cachedTokens: typeof cached === "number" ? cached : null,
  };
}
