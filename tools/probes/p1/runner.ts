import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROBES_DIR, loadConfig, parseArgs, redact, type CliArgs, type ProbeConfig } from "../shared/env";
import { startMockServer, type MockServer } from "../shared/mockServer";
import { OUT_DIR, stamp, writeJson, writeText } from "../shared/io";
import { FORMATS } from "./formats";
import type { CallMetrics, FormatRequest, ProbeInput } from "./types";
import { summarize, renderMatrix, type FormatSummary } from "./score";

/** 这 3 条固定输入只跑取消测试（每格式 20 次调用上限 = 17 条全量 + 3 次取消）。 */
export const CANCEL_INPUT_IDS = ["g1", "o1", "s1"] as const;

const INPUTS: readonly ProbeInput[] = JSON.parse(
  readFileSync(join(PROBES_DIR, "p1", "inputs.json"), "utf8"),
) as ProbeInput[];

export type P1Result = {
  probe: "p1";
  mode: "mock" | "real";
  timestamp: string;
  model: string;
  baseUrl: string;
  thinking: "disabled";
  temperature: number;
  inputs: number;
  cancelInputIds: readonly string[];
  callsPerFormat: number;
  totalCalls: number;
  formats: Record<string, { calls: CallMetrics[]; cancellation: CallMetrics[]; summary: FormatSummary }>;
};

async function runFormat(
  format: (typeof FORMATS)[number],
  config: ProbeConfig,
): Promise<{ calls: CallMetrics[]; cancellation: CallMetrics[] }> {
  const calls: CallMetrics[] = [];
  const cancellation: CallMetrics[] = [];
  let consecutiveFailures = 0;
  for (const input of INPUTS) {
    const request: FormatRequest = {
      input,
      scene: { node: "probe", history: [] },
      config,
      abortAfterFirstBeat: (CANCEL_INPUT_IDS as readonly string[]).includes(input.id),
    };
    const metrics = await format.run(request);
    const transportFailure =
      metrics.error !== null && (metrics.httpStatus === null || metrics.httpStatus >= 400 || metrics.units === 0);
    consecutiveFailures = transportFailure ? consecutiveFailures + 1 : 0;
    if (request.abortAfterFirstBeat) {
      cancellation.push(metrics);
      console.log(
        `  ${format.id} 取消 ${input.id}: aborted=${metrics.aborted} 关闭耗时=${fmt(metrics.abortToCloseMs)}ms 首个合法 beat=${fmt(metrics.firstValidBeatMs)}ms`,
      );
    } else {
      calls.push(metrics);
      console.log(
        `  ${format.id} ${input.id} (${input.type}): 首 beat=${fmt(metrics.firstValidBeatMs)}ms 总=${fmt(metrics.totalMs)}ms 单元=${metrics.units} 合法=${metrics.strictValidUnits} 枚举=${metrics.enumValidUnits}${metrics.error ? ` 错误=${metrics.error}` : ""}`,
      );
    }
    if (consecutiveFailures >= 2) {
      console.error(`  ${format.id} 连续 ${consecutiveFailures} 次传输级失败，提前结束该格式（避免继续花钱）`);
      break;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 120);
    await promise;
  }
  return { calls, cancellation };
}

function fmt(value: number | null): string {
  return value === null ? "—" : value.toFixed(0);
}

/** --formats=b / --merge=out/p1-xxx.json：补跑单个格式并把结果并回同一份报告。 */
function readFlag(rest: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = rest.find((arg) => arg.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

export async function runP1(args: CliArgs = parseArgs(process.argv.slice(2))): Promise<P1Result> {
  const renderPath = readFlag(args.rest, "render");
  if (renderPath !== null) {
    // 只重排已有结果，不发请求；复杂度等主观分按当前代码重算。
    const existing = JSON.parse(readFileSync(renderPath, "utf8")) as P1Result;
    for (const format of FORMATS) {
      const entry = existing.formats[format.id];
      if (entry !== undefined) entry.summary = summarize(format, entry.calls, entry.cancellation);
    }
    writeJson(renderPath, existing);
    const mdPath = renderPath.replace(/\.json$/, ".md");
    writeText(mdPath, renderMatrix(existing));
    console.log(redact(`[p1] 矩阵已重排：${mdPath}`));
    return existing;
  }
  const config = loadConfig(args);
  const selectedIds = readFlag(args.rest, "formats")?.split(",") ?? FORMATS.map((format) => format.id);
  const mergePath = readFlag(args.rest, "merge");
  const selected = FORMATS.filter((format) => selectedIds.includes(format.id));
  if (selected.length === 0) throw new Error(`--formats 只接受 ${FORMATS.map((f) => f.id).join(",")}`);

  let mockServer: MockServer | null = null;
  if (config.mock) {
    mockServer = await startMockServer();
    config.deepseek.baseUrl = `${mockServer.baseUrl}/v1`;
  }

  const timestamp = stamp();
  const formats: P1Result["formats"] = {};
  let callsMade = 0;
  try {
    for (const format of selected) {
      console.log(`[p1] 格式 ${format.label}`);
      const { calls, cancellation } = await runFormat(format, config);
      callsMade += calls.length + cancellation.length;
      formats[format.id] = { calls, cancellation, summary: summarize(format, calls, cancellation) };
    }
  } finally {
    await mockServer?.close();
  }

  if (mergePath !== null) {
    const previous = JSON.parse(readFileSync(mergePath, "utf8")) as P1Result;
    for (const [id, entry] of Object.entries(previous.formats)) {
      if (formats[id] === undefined) formats[id] = entry;
    }
  }

  const result: P1Result = {
    probe: "p1",
    mode: config.mock ? "mock" : "real",
    timestamp,
    model: config.deepseek.model,
    baseUrl: config.deepseek.baseUrl,
    thinking: "disabled",
    temperature: 0.7,
    inputs: INPUTS.length,
    cancelInputIds: CANCEL_INPUT_IDS,
    callsPerFormat: INPUTS.length,
    totalCalls: Object.values(formats).reduce((sum, entry) => sum + entry.calls.length + entry.cancellation.length, 0),
    formats,
  };
  console.log(`[p1] 本次实际调用 ${callsMade} 次`);

  const suffix = config.mock ? `${timestamp}-mock` : timestamp;
  const jsonPath = join(OUT_DIR, `p1-${suffix}.json`);
  const mdPath = join(OUT_DIR, `p1-${suffix}.md`);
  writeJson(jsonPath, result);
  writeText(mdPath, renderMatrix(result));
  console.log(redact(`[p1] 结果：${jsonPath}\n[p1] 矩阵：${mdPath}`));
  return result;
}
