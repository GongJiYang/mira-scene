export type ProviderMode = "mock";

export type ServerConfig = {
  providerMode: ProviderMode;
  port: number;
};

const SUPPORTED_MODES: readonly ProviderMode[] = ["mock"];

function isProviderMode(value: string): value is ProviderMode {
  return (SUPPORTED_MODES as readonly string[]).includes(value);
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
  return { providerMode: rawMode, port };
}
