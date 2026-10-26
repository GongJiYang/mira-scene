import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, stamp, writeJson } from "../shared/io";
import { loadConfig, parseArgs, redact, type CliArgs, type ProbeConfig } from "../shared/env";
import { startMockServer, type MockServer } from "../shared/mockServer";
import { cer, round } from "../shared/stats";

export const P2_REFERENCE =
  "今天下了一整天的雨，我在这条街上等你很久了，桌上那杯咖啡已经凉了。";

const AUDIO_DIR = join(OUT_DIR, "p2");

export type P2Entry = {
  format: string;
  file: string;
  bytes: number;
  durationSec: number | null;
  httpStatus: number | null;
  ok: boolean;
  text: string | null;
  cer: number | null;
  latencyMs: number | null;
  error: string | null;
};

export type P2Result = {
  probe: "p2";
  mode: "mock" | "real";
  timestamp: string;
  voice: string;
  reference: string;
  model: string;
  formats: P2Entry[];
  totalCalls: number;
};

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} 失败：${redact(result.stderr.trim() || result.stdout.trim())}`);
  }
  return result.stdout;
}

function probeDuration(file: string): number | null {
  const output = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  const value = Number.parseFloat(output.stdout.trim());
  return Number.isFinite(value) ? value : null;
}

/** say → aiff → webm(opus) / mp4(aac) / wav，模拟浏览器能录的三种容器。 */
function buildAudioFiles(): Array<{ format: string; file: string }> {
  mkdirSync(AUDIO_DIR, { recursive: true });
  const source = join(AUDIO_DIR, "source.aiff");
  if (!existsSync(source)) {
    run("say", ["-v", "Ting-Ting", "-o", source, P2_REFERENCE]);
  }
  const targets = [
    {
      format: "webm(opus)",
      file: join(AUDIO_DIR, "browser.webm"),
      args: ["-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1"],
    },
    {
      format: "mp4(aac)",
      file: join(AUDIO_DIR, "browser.mp4"),
      args: ["-c:a", "aac", "-b:a", "64k", "-ar", "44100", "-ac", "1"],
    },
    {
      format: "wav",
      file: join(AUDIO_DIR, "browser.wav"),
      args: ["-c:a", "pcm_s16le", "-ar", "24000", "-ac", "1"],
    },
  ];
  for (const target of targets) {
    run("ffmpeg", ["-y", "-loglevel", "error", "-i", source, ...target.args, target.file]);
  }
  return targets.map(({ format, file }) => ({ format, file }));
}

async function transcribe(
  config: ProbeConfig,
  format: string,
  file: string,
): Promise<P2Entry> {
  const bytes = readFileSync(file);
  const entry: P2Entry = {
    format,
    file,
    bytes: statSync(file).size,
    durationSec: round(probeDuration(file), 3),
    httpStatus: null,
    ok: false,
    text: null,
    cer: null,
    latencyMs: null,
    error: null,
  };

  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), "sample");
  form.append("ignore_timestamps", "true");
  form.append("language", "zh");

  const started = performance.now();
  try {
    const response = await fetch(`${config.fish.baseUrl}/asr`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.fish.apiKey}`,
        model: "transcribe-1-pro",
      },
      body: form,
    });
    entry.latencyMs = round(performance.now() - started);
    entry.httpStatus = response.status;
    const raw = await response.text();
    if (!response.ok) {
      entry.error = redact(`HTTP ${response.status} ${raw.slice(0, 300)}`);
      return entry;
    }
    const parsed = JSON.parse(raw) as { text?: string; duration?: number };
    entry.text = parsed.text ?? null;
    entry.ok = typeof parsed.text === "string" && parsed.text.trim() !== "";
    entry.cer = entry.text === null ? null : round(cer(P2_REFERENCE, entry.text), 4);
    if (typeof parsed.duration === "number") entry.durationSec = round(parsed.duration, 3);
  } catch (error) {
    entry.error = redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
  return entry;
}

export async function runP2(args: CliArgs = parseArgs(process.argv.slice(2))): Promise<P2Result> {
  const config = loadConfig(args);
  const targets = buildAudioFiles();
  let mockServer: MockServer | null = null;
  if (config.mock) {
    mockServer = await startMockServer({ asrText: P2_REFERENCE });
    config.fish.baseUrl = `${mockServer.baseUrl}/v1`;
  }

  const entries: P2Entry[] = [];
  try {
    for (const target of targets) {
      const entry = await transcribe(config, target.format, target.file);
      entries.push(entry);
      console.log(
        `[p2] ${entry.format}: ok=${entry.ok} 耗时=${entry.latencyMs ?? "—"}ms CER=${entry.cer ?? "—"}${entry.error ? ` 错误=${entry.error}` : ""}`,
      );
      console.log(`     识别：${entry.text ?? "（空）"}`);
    }
  } finally {
    await mockServer?.close();
  }

  const timestamp = stamp();
  const result: P2Result = {
    probe: "p2",
    mode: config.mock ? "mock" : "real",
    timestamp,
    voice: "Ting-Ting",
    reference: P2_REFERENCE,
    model: "transcribe-1-pro",
    formats: entries,
    totalCalls: entries.length,
  };
  const path = join(OUT_DIR, `p2-${config.mock ? `${timestamp}-mock` : timestamp}.json`);
  writeJson(path, result);
  console.log(`[p2] 结果：${path}`);
  return result;
}
