import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ProviderMode = "mock" | "real";

export type DeepSeekCredentials = {
  apiKey: string;
  /** 统一成以 `/v1` 结尾。 */
  baseUrl: string;
  model: string;
};

export type FishCredentials = {
  apiKey: string;
  baseUrl: string;
  /** 为空表示不传 `reference_id`。 */
  voiceId: string;
  ttsModel: string;
};

export type ProviderCredentials = {
  deepseek: DeepSeekCredentials;
  fish: FishCredentials;
};

export type ServerConfig = {
  providerMode: ProviderMode;
  port: number;
  /** 每会话最多轮数（Q12，默认 30）。 */
  sessionTurnLimit: number;
  /** 全站每天最多轮数（Q12，默认 300）。 */
  dailyTurnLimit: number;
  /** D27：预置照片媒体就绪的模拟时长（毫秒，默认 2500）。 */
  mediaPresetDelayMs: number;
  /**
   * S5 §1：Mock 预录语音清单路径（默认 `<仓库根>/assets/voice/manifest.json`，
   * 可用 `VOICE_MANIFEST` 覆盖）。仅在 Mock TTS 适配器里使用，不读取任何 Key。
   */
  voiceManifestPath: string;
  /** real 模式下的凭据；mock 模式下全为空串，绝不读取 Key。 */
  providers: ProviderCredentials;
};

const SUPPORTED_MODES: readonly ProviderMode[] = ["mock", "real"];

export const DEFAULT_SESSION_TURN_LIMIT = 30;
export const DEFAULT_DAILY_TURN_LIMIT = 300;
export const DEFAULT_MEDIA_PRESET_DELAY_MS = 2_500;
/** S5 §1：默认预录语音清单相对仓库根的位置。 */
export const DEFAULT_VOICE_MANIFEST_RELATIVE = "assets/voice/manifest.json";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_FISH_BASE_URL = "https://api.fish.audio";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
export const DEFAULT_FISH_TTS_MODEL = "s2.1-pro-free";

const EMPTY_PROVIDERS: ProviderCredentials = {
  deepseek: { apiKey: "", baseUrl: "", model: "" },
  fish: { apiKey: "", baseUrl: "", voiceId: "", ttsModel: "" },
};

function isProviderMode(value: string): value is ProviderMode {
  return (SUPPORTED_MODES as readonly string[]).includes(value);
}

/** 正整数环境变量；非法值直接抛错，不静默降级。 */
function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`非法的 ${name}="${raw}"`);
  const value = Number.parseInt(raw, 10);
  if (value <= 0) throw new Error(`非法的 ${name}="${raw}"`);
  return value;
}

/** 统一成 `<root>/v1`，路由拼在它后面。 */
export function normalizeV1(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function readCredentials(env: NodeJS.ProcessEnv): ProviderCredentials {
  const text = (name: string): string => (env[name] ?? "").trim();
  return {
    deepseek: {
      apiKey: text("DEEPSEEK_API_KEY"),
      baseUrl: normalizeV1(text("DEEPSEEK_BASE_URL") || DEFAULT_DEEPSEEK_BASE_URL),
      model: text("DEEPSEEK_MODEL") || DEFAULT_DEEPSEEK_MODEL,
    },
    fish: {
      apiKey: text("FISH_API_KEY"),
      baseUrl: normalizeV1(text("FISH_BASE_URL") || DEFAULT_FISH_BASE_URL),
      voiceId: text("FISH_VOICE_ID"),
      ttsModel: text("FISH_TTS_MODEL") || DEFAULT_FISH_TTS_MODEL,
    },
  };
}

/**
 * 读取配置。默认从 `process.env` 读；`PROVIDER_MODE` 默认 `mock`。
 * 只有 `real` 模式才会读取凭据，mock 模式下绝不触碰任何 Key（Q10）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawMode = (env.PROVIDER_MODE ?? "mock").trim() || "mock";
  if (!isProviderMode(rawMode)) {
    throw new Error(`不支持的 PROVIDER_MODE="${rawMode}"，只支持 ${SUPPORTED_MODES.join(", ")}`);
  }
  const rawPort = env.PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`非法的 PORT="${rawPort}"`);
  }
  return {
    providerMode: rawMode,
    port,
    sessionTurnLimit: readPositiveInt(env, "SESSION_TURN_LIMIT", DEFAULT_SESSION_TURN_LIMIT),
    dailyTurnLimit: readPositiveInt(env, "DAILY_TURN_LIMIT", DEFAULT_DAILY_TURN_LIMIT),
    mediaPresetDelayMs: readPositiveInt(env, "MEDIA_PRESET_DELAY_MS", DEFAULT_MEDIA_PRESET_DELAY_MS),
    voiceManifestPath: resolveVoiceManifestPath(env),
    providers: rawMode === "real" ? readCredentials(env) : EMPTY_PROVIDERS,
  };
}

/** Mock 预录语音清单路径：`VOICE_MANIFEST` 覆盖，否则用仓库根下的默认位置。 */
export function resolveVoiceManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VOICE_MANIFEST?.trim();
  if (override) return override;
  return join(repoRoot(), DEFAULT_VOICE_MANIFEST_RELATIVE);
}

/** 极简 .env 解析：KEY=VALUE，支持 # 注释与成对引号。 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key !== "") out[key] = value;
  }
  return out;
}

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("找不到仓库根目录（pnpm-workspace.yaml）");
    dir = parent;
  }
}

/** 从本模块位置向上找仓库根（`pnpm-workspace.yaml` 所在处）。 */
function repoRoot(): string {
  return findRepoRoot(dirname(fileURLToPath(import.meta.url)));
}

/** 读取仓库根目录的 `.env`（不存在则返回空表）。Key 只在这里读取，永不打印。 */
export function readRepoEnvFile(): Record<string, string> {
  const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const path = join(root, ".env");
  if (!existsSync(path)) return {};
  return parseEnvFile(readFileSync(path, "utf8"));
}

/** 把仓库根 `.env` 里缺失的键补进 `env`（不覆盖已存在的值）。 */
export function applyRepoEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(readRepoEnvFile())) {
    if (env[key] === undefined || env[key] === "") env[key] = value;
  }
}
