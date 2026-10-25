export type ProviderMode = "mock";

export type ServerConfig = {
  providerMode: ProviderMode;
  port: number;
  /** 每会话最多轮数（Q12，默认 30）。 */
  sessionTurnLimit: number;
  /** 全站每天最多轮数（Q12，默认 300）。 */
  dailyTurnLimit: number;
};

const SUPPORTED_MODES: readonly ProviderMode[] = ["mock"];

export const DEFAULT_SESSION_TURN_LIMIT = 30;
export const DEFAULT_DAILY_TURN_LIMIT = 300;

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

/**
 * S2 只支持 mock。读取环境变量但不读取任何 API Key。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawMode = (env.PROVIDER_MODE ?? "mock").trim() || "mock";
  if (!isProviderMode(rawMode)) {
    throw new Error(`不支持的 PROVIDER_MODE="${rawMode}"，S2 只支持 ${SUPPORTED_MODES.join(", ")}`);
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
  };
}
