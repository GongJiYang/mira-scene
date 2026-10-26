import { percentile, round } from "../shared/stats";
import type { CallMetrics } from "./types";
import type { FormatModule } from "./formats";

export const WEIGHTS = { latency: 0.4, compliance: 0.3, complexity: 0.15, cancellation: 0.15 } as const;

export type FormatSummary = {
  calls: number;
  firstValidBeats: number;
  latency: { p50: number | null; p90: number | null; min: number | null; max: number | null; mean: number | null };
  total: { p50: number | null; p90: number | null; mean: number | null };
  parseRate: number;
  enumRate: number;
  firstSayRate: number;
  firstSayMeanLen: number | null;
  units: { total: number; strict: number; enumValid: number };
  errors: number;
  cache: { callsWithCacheField: number; cachedTokensTotal: number; hitTokensTotal: number; missTokensTotal: number };
  cancellation: {
    runs: number;
    succeeded: number;
    meanMs: number | null;
    maxMs: number | null;
    detail: Array<{ inputId: string; closedMs: number | null; aborted: boolean }>;
  };
  complexity: { score: number; reason: string };
  score: { latency: number; compliance: number; complexity: number; cancellation: number; total: number };
};

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const clamp = (value: number): number => Math.min(100, Math.max(0, value));

/** 首句延迟分：600ms 记满分，2000ms 记 0（线性）。 */
function latencyScore(p50: number | null): number {
  if (p50 === null) return 0;
  return clamp(((2000 - p50) / 1400) * 100);
}

/** 取消耗时分：关闭耗时 100ms 记满分，500ms 记 0；失败按比例扣。 */
function cancellationScore(values: readonly (number | null)[], aborted: readonly boolean[]): number {
  const total = values.length;
  if (total === 0) return 0;
  const ok = values.filter((value, index) => aborted[index] === true && value !== null && value <= 500);
  const successRate = ok.length / total;
  const average = mean(ok as number[]);
  if (average === null) return 0;
  return clamp(((500 - average) / 400) * 100) * successRate;
}

export function summarize(
  format: FormatModule,
  calls: readonly CallMetrics[],
  cancellation: readonly CallMetrics[],
): FormatSummary {
  const firstBeats = calls.flatMap((call) => (call.firstValidBeatMs === null ? [] : [call.firstValidBeatMs]));
  const totals = calls.map((call) => call.totalMs);
  const units = calls.reduce((sum, call) => sum + call.units, 0);
  const strict = calls.reduce((sum, call) => sum + call.strictValidUnits, 0);
  const enumValid = calls.reduce((sum, call) => sum + call.enumValidUnits, 0);
  const withFirst = calls.filter((call) => call.firstSayWithin20 !== null);
  const firstSayOk = withFirst.filter((call) => call.firstSayWithin20 === true).length;
  const firstSayLens = calls.flatMap((call) => (call.firstSayLen === null ? [] : [call.firstSayLen]));

  const parseRate = units === 0 ? 0 : strict / units;
  const enumRate = units === 0 ? 0 : enumValid / units;
  const firstSayRate = withFirst.length === 0 ? 0 : firstSayOk / withFirst.length;

  const cacheCalls = calls.filter((call) => call.cache.cachedTokens !== null);
  const cancelledMs = cancellation.flatMap((call) =>
    call.abortToCloseMs === null ? [] : [call.abortToCloseMs],
  );

  const latency = latencyScore(percentile(firstBeats, 50));
  const compliance = 100 * (parseRate * 0.5 + enumRate * 0.3 + firstSayRate * 0.2);
  const cancel = cancellationScore(
    cancellation.map((call) => call.abortToCloseMs),
    cancellation.map((call) => call.aborted),
  );
  const total = WEIGHTS.latency * latency + WEIGHTS.compliance * compliance + WEIGHTS.complexity * format.complexity.score + WEIGHTS.cancellation * cancel;

  return {
    calls: calls.length,
    firstValidBeats: firstBeats.length,
    latency: {
      p50: round(percentile(firstBeats, 50)),
      p90: round(percentile(firstBeats, 90)),
      min: round(firstBeats.length === 0 ? null : Math.min(...firstBeats)),
      max: round(firstBeats.length === 0 ? null : Math.max(...firstBeats)),
      mean: round(mean(firstBeats)),
    },
    total: {
      p50: round(percentile(totals, 50)),
      p90: round(percentile(totals, 90)),
      mean: round(mean(totals)),
    },
    parseRate,
    enumRate,
    firstSayRate,
    firstSayMeanLen: round(mean(firstSayLens)),
    units: { total: units, strict, enumValid },
    errors: calls.filter((call) => call.error !== null).length,
    cache: {
      callsWithCacheField: cacheCalls.length,
      cachedTokensTotal: cacheCalls.reduce((sum, call) => sum + (call.cache.cachedTokens ?? 0), 0),
      hitTokensTotal: cacheCalls.reduce((sum, call) => sum + (call.cache.hitTokens ?? 0), 0),
      missTokensTotal: cacheCalls.reduce((sum, call) => sum + (call.cache.missTokens ?? 0), 0),
    },
    cancellation: {
      runs: cancellation.length,
      succeeded: cancellation.filter((call) => call.aborted && call.abortToCloseMs !== null && call.abortToCloseMs <= 500).length,
      meanMs: round(mean(cancelledMs)),
      maxMs: round(cancelledMs.length === 0 ? null : Math.max(...cancelledMs)),
      detail: cancellation.map((call) => ({
        inputId: call.inputId,
        closedMs: round(call.abortToCloseMs),
        aborted: call.aborted,
      })),
    },
    complexity: format.complexity,
    score: {
      latency: round(latency, 1) ?? 0,
      compliance: round(compliance, 1) ?? 0,
      complexity: format.complexity.score,
      cancellation: round(cancel, 1) ?? 0,
      total: round(total, 1) ?? 0,
    },
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const ms = (value: number | null): string => (value === null ? "—" : `${value.toFixed(0)}`);

export function renderMatrix(result: {
  mode: string;
  timestamp: string;
  model: string;
  inputs: number;
  callsPerFormat: number;
  totalCalls: number;
  cancelInputIds: readonly string[];
  formats: Record<string, { calls: CallMetrics[]; summary: FormatSummary }>;
}): string {
  const ids = Object.keys(result.formats);
  const lines: string[] = [];
  lines.push(`# P1 输出格式矩阵（${result.mode}）`, "");
  lines.push(`- 时间：${result.timestamp}`);
  lines.push(`- 模型：${result.model}（thinking disabled，temperature 0.7，流式）`);
  lines.push(
    `- 调用：每格式 ${result.callsPerFormat} 次（${result.inputs - result.cancelInputIds.length} 条全量 + ${result.cancelInputIds.length} 次取消：${result.cancelInputIds.join(", ")}），计入统计 ${result.totalCalls} 次`,
  );
  lines.push("");

  lines.push("## 加权总分", "");
  lines.push("权重：首句延迟 40% · 合规率 30% · 复杂度 15% · 取消友好度 15%", "");
  lines.push("| 格式 | 首句延迟 | 合规率 | 复杂度 | 取消友好度 | 加权总分 |");
  lines.push("|---|---|---|---|---|---|");
  for (const id of ids) {
    const summary = result.formats[id]?.summary;
    if (!summary) continue;
    lines.push(
      `| ${id} | ${summary.score.latency.toFixed(1)} | ${summary.score.compliance.toFixed(1)} | ${summary.score.complexity} | ${summary.score.cancellation.toFixed(1)} | **${summary.score.total.toFixed(1)}** |`,
    );
  }
  lines.push("");

  lines.push("## 首句延迟（收到第一个合法 beat 的毫秒数）", "");
  lines.push("| 格式 | 有首 beat 的调用 | P50 | P90 | min | max | 平均 | 整轮 P50 | 整轮 P90 |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const id of ids) {
    const summary = result.formats[id]?.summary;
    if (!summary) continue;
    lines.push(
      `| ${id} | ${summary.firstValidBeats}/${summary.calls} | ${ms(summary.latency.p50)} | ${ms(summary.latency.p90)} | ${ms(summary.latency.min)} | ${ms(summary.latency.max)} | ${ms(summary.latency.mean)} | ${ms(summary.total.p50)} | ${ms(summary.total.p90)} |`,
    );
  }
  lines.push("");

  lines.push("## 合规率", "");
  lines.push("| 格式 | 解析成功率（单元加权） | 枚举合法率 | 首句 ≤20 字 | 首句平均字数 | 单元数 | 出错调用 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const id of ids) {
    const summary = result.formats[id]?.summary;
    if (!summary) continue;
    lines.push(
      `| ${id} | ${pct(summary.parseRate)} | ${pct(summary.enumRate)} | ${pct(summary.firstSayRate)} | ${ms(summary.firstSayMeanLen)} | ${summary.units.total} | ${summary.errors} |`,
    );
  }
  lines.push("");

  lines.push("## 取消友好度（收到首个合法 beat 后 abort）", "");
  lines.push("| 格式 | 成功次数 | 平均关闭耗时 | 最大关闭耗时 |");
  lines.push("|---|---|---|---|");
  for (const id of ids) {
    const summary = result.formats[id]?.summary;
    if (!summary) continue;
    lines.push(
      `| ${id} | ${summary.cancellation.succeeded}/${summary.cancellation.runs} | ${ms(summary.cancellation.meanMs)} | ${ms(summary.cancellation.maxMs)} |`,
    );
  }
  lines.push("");

  lines.push("## 前缀缓存", "");
  lines.push("| 格式 | 带缓存字段的调用 | 命中 token 合计（cached_tokens） | 未命中 token 合计（仅 DeepSeek 原始字段） |");
  lines.push("|---|---|---|---|");
  for (const id of ids) {
    const summary = result.formats[id]?.summary;
    if (!summary) continue;
    lines.push(
      `| ${id} | ${summary.cache.callsWithCacheField}/${summary.calls} | ${summary.cache.cachedTokensTotal} | ${summary.cache.missTokensTotal === 0 ? "—" : summary.cache.missTokensTotal} |`,
    );
  }
  lines.push("");

  lines.push("## 复杂度（主观分，含理由）", "");
  for (const id of ids) {
    const summary = result.formats[id]?.summary;
    if (!summary) continue;
    lines.push(`- **${id}**（${summary.complexity.score}/100）：${summary.complexity.reason}`);
  }
  lines.push("");

  lines.push("## 原始输出样例（每格式 2 条）", "");
  for (const id of ids) {
    const calls = (result.formats[id]?.calls ?? []).slice(0, 2);
    for (const call of calls) {
      lines.push(`### ${id} · ${call.inputId}（${call.inputType}）`, "", "```", call.rawText.trim(), "```", "");
    }
  }
  return lines.join("\n");
}
