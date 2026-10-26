import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, stamp, writeJson, writeText } from "../shared/io";
import { loadConfig, parseArgs, redact, type CliArgs, type ProbeConfig } from "../shared/env";
import { startMockServer, type MockServer } from "../shared/mockServer";
import { percentile, round } from "../shared/stats";
import { renderBlindPage } from "./blind";

/** D29 的情绪 → Fish 标签（与 apps/server/src/director/vocab.ts 的 FISH_EMOTION_TAGS 一致）。 */
export const FISH_TAGS: ReadonlyArray<{ emotion: string; tag: string | null }> = [
  { emotion: "neutral", tag: null },
  { emotion: "calm", tag: "[calm]" },
  { emotion: "guarded", tag: "[soft tone]" },
  { emotion: "sad", tag: "[sad]" },
  { emotion: "warm", tag: "[gentle]" },
  { emotion: "surprised", tag: "[surprised]" },
];

export const P3_LINE = "雨还在下，先坐吧。";
const MODELS = ["s2.1-pro-free", "drama-3"] as const;
const P3_DIR = join(OUT_DIR, "p3");

export type P3Entry = {
  model: string;
  emotion: string;
  tag: string | null;
  text: string;
  voiceId: string | null;
  ttfbMs: number | null;
  totalMs: number | null;
  bytes: number;
  durationSec: number | null;
  httpStatus: number | null;
  ok: boolean;
  error: string | null;
  file: string;
};

export type P3Result = {
  probe: "p3";
  mode: "mock" | "real";
  timestamp: string;
  line: string;
  models: readonly string[];
  voiceId: string | null;
  entries: P3Entry[];
  summary: Record<
    string,
    { ttfbP50: number | null; ttfbP90: number | null; totalMean: number | null; ok: number; calls: number }
  >;
  blindPage: string;
  totalCalls: number;
};

function probeDuration(file: string): number | null {
  const output = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  const value = Number.parseFloat(output.stdout.trim());
  return Number.isFinite(value) ? value : null;
}

async function synthesize(
  config: ProbeConfig,
  model: string,
  emotion: string,
  tag: string | null,
): Promise<P3Entry> {
  const dir = join(P3_DIR, model);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${emotion}.mp3`);
  const text = tag === null ? P3_LINE : `${tag} ${P3_LINE}`;
  const entry: P3Entry = {
    model,
    emotion,
    tag,
    text,
    voiceId: config.fish.voiceId === "" ? null : config.fish.voiceId,
    ttfbMs: null,
    totalMs: null,
    bytes: 0,
    durationSec: null,
    httpStatus: null,
    ok: false,
    error: null,
    file,
  };

  const started = performance.now();
  try {
    const response = await fetch(`${config.fish.baseUrl}/tts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.fish.apiKey}`,
        "content-type": "application/json",
        model,
      },
      body: JSON.stringify({
        text,
        format: "mp3",
        mp3_bitrate: 128,
        latency: "normal",
        normalize: true,
        language: "zh",
        ...(config.fish.voiceId === "" ? {} : { reference_id: config.fish.voiceId }),
      }),
    });
    entry.httpStatus = response.status;
    if (!response.ok || response.body === null) {
      entry.error = redact(`HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}`);
      return entry;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        if (entry.ttfbMs === null) entry.ttfbMs = round(performance.now() - started);
        chunks.push(value);
      }
    }
    entry.totalMs = round(performance.now() - started);
    const audio = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    entry.bytes = audio.length;
    entry.ok = audio.length > 0;
    writeFileSync(file, audio);
    entry.durationSec = round(probeDuration(file), 3);
  } catch (error) {
    entry.error = redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
  return entry;
}

function makeMockSilence(): Buffer {
  mkdirSync(P3_DIR, { recursive: true });
  const file = join(P3_DIR, "mock-silence.mp3");
  const result = spawnSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=24000:cl=mono",
    "-t",
    "1.2",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    file,
  ]);
  if (result.status !== 0) throw new Error("生成 mock 静音 mp3 失败（需要 ffmpeg）");
  return readFileSync(file);
}

export async function runP3(args: CliArgs = parseArgs(process.argv.slice(2))): Promise<P3Result> {
  const config = loadConfig(args);
  let mockServer: MockServer | null = null;
  if (config.mock) {
    mockServer = await startMockServer({ ttsAudio: makeMockSilence() });
    config.fish.baseUrl = `${mockServer.baseUrl}/v1`;
  }

  const entries: P3Entry[] = [];
  try {
    for (const model of MODELS) {
      for (const { emotion, tag } of FISH_TAGS) {
        const entry = await synthesize(config, model, emotion, tag);
        entries.push(entry);
        console.log(
          `[p3] ${model} / ${emotion}: 首字节=${entry.ttfbMs ?? "—"}ms 总=${entry.totalMs ?? "—"}ms 大小=${entry.bytes}B${entry.error ? ` 错误=${entry.error}` : ""}`,
        );
      }
    }
  } finally {
    await mockServer?.close();
  }

  const summary: P3Result["summary"] = {};
  for (const model of MODELS) {
    const rows = entries.filter((entry) => entry.model === model);
    const ttfb = rows.flatMap((entry) => (entry.ttfbMs === null ? [] : [entry.ttfbMs]));
    const totals = rows.flatMap((entry) => (entry.totalMs === null ? [] : [entry.totalMs]));
    summary[model] = {
      ttfbP50: round(percentile(ttfb, 50)),
      ttfbP90: round(percentile(ttfb, 90)),
      totalMean: round(totals.length === 0 ? null : totals.reduce((sum, value) => sum + value, 0) / totals.length),
      ok: rows.filter((entry) => entry.ok).length,
      calls: rows.length,
    };
  }

  const timestamp = stamp();
  const blindPath = join(P3_DIR, "blind.html");
  writeText(blindPath, renderBlindPage(entries, Date.now() % 100_000));

  const result: P3Result = {
    probe: "p3",
    mode: config.mock ? "mock" : "real",
    timestamp,
    line: P3_LINE,
    models: MODELS,
    voiceId: config.fish.voiceId === "" ? null : config.fish.voiceId,
    entries,
    summary,
    blindPage: blindPath,
    totalCalls: entries.length,
  };
  const path = join(OUT_DIR, `p3-${config.mock ? `${timestamp}-mock` : timestamp}.json`);
  writeJson(path, result);
  console.log(`[p3] 结果：${path}\n[p3] 盲听页：${blindPath}`);
  return result;
}
