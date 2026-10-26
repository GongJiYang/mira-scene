import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";

/** 探针脚本所在目录（tools/probes）。 */
export const PROBES_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    try {
      readFileSync(join(dir, "pnpm-workspace.yaml"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) throw new Error("找不到仓库根目录（pnpm-workspace.yaml）");
      dir = parent;
    }
  }
}

export const REPO_ROOT = findRepoRoot(PROBES_DIR);
export const ENV_PATH = join(REPO_ROOT, ".env");

/**
 * 只从仓库根目录的 `.env` 读 Key，不读 `process.env`。
 * `.env` 缺失时返回空表（mock 模式不需要 Key）。
 */
function readEnvFile(): Record<string, string> {
  try {
    return parseDotenv(readFileSync(ENV_PATH));
  } catch {
    return {};
  }
}

const fileEnv = readEnvFile();

/** 已读到的 Key 值，用于脱敏。永不打印。 */
const secrets: string[] = Object.entries(fileEnv)
  .filter(([key, value]) => /KEY|TOKEN|SECRET/i.test(key) && value.trim() !== "")
  .map(([, value]) => value.trim());

/** 把任何出现的 Key 值替换掉；所有错误输出都必须先过这里。 */
export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("<redacted>");
  return out;
}

export type ProbeConfig = {
  mock: boolean;
  deepseek: { baseUrl: string; model: string; apiKey: string };
  fish: { baseUrl: string; apiKey: string; voiceId: string; ttsModel: string };
};

function value(name: string): string {
  return (fileEnv[name] ?? "").trim();
}

export type CliArgs = { mock: boolean; rest: string[] };

export function parseArgs(argv: string[]): CliArgs {
  return { mock: argv.includes("--mock"), rest: argv.filter((a) => a !== "--mock") };
}

/** 打印错误并以退出码 2 结束（缺 Key 或 Key 不可用）。 */
export function fail(message: string): never {
  console.error(redact(`[probe] ${message}`));
  process.exit(2);
}

export function loadConfig(args: CliArgs): ProbeConfig {
  if (args.mock) {
    return {
      mock: true,
      // mock 用本地假服务；下面的 baseUrl 由 runner 覆盖。
      deepseek: { baseUrl: "http://127.0.0.1:0/v1", model: "mock-model", apiKey: "mock-key" },
      fish: { baseUrl: "http://127.0.0.1:0", apiKey: "mock-key", voiceId: "", ttsModel: "s2.1-pro-free" },
    };
  }

  const missing = ["FISH_API_KEY", "DEEPSEEK_API_KEY"].filter((name) => value(name) === "");
  if (missing.length > 0) {
    fail(`缺少 ${missing.join(", ")}（应从仓库根目录 .env 读取）`);
  }
  const deepseekBase = value("DEEPSEEK_BASE_URL") || "https://api.deepseek.com";
  return {
    mock: false,
    deepseek: {
      baseUrl: normalizeV1(deepseekBase),
      model: value("DEEPSEEK_MODEL") || "deepseek-chat",
      apiKey: value("DEEPSEEK_API_KEY"),
    },
    fish: {
      baseUrl: normalizeV1(value("FISH_BASE_URL") || "https://api.fish.audio"),
      apiKey: value("FISH_API_KEY"),
      voiceId: value("FISH_VOICE_ID"),
      ttsModel: value("FISH_TTS_MODEL") || "s2.1-pro-free",
    },
  };
}

/** 统一成 `<root>/v1`，路由拼在它后面。 */
export function normalizeV1(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
