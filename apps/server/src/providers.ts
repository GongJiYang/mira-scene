/**
 * D49 / S6n §1：Provider 工厂（服务端）。
 *
 * 组装 STT / LLM / TTS / 场景扩写 / 生图适配器的逻辑集中在这里；`index.ts` 与
 * `session.ts` 只调用工厂，不再各自拼装。核心是**纯函数**（模式判定、capabilities、
 * Key 选择），工厂只是把这些纯函数的结论落成适配器实例（函数式核心 / 外壳）。
 *
 * Key 安全（铁律）：访问者自带的 Key 只在本会话内存中使用；服务端 `.env` 的 Key 只从
 * `serverConfig` 读取。**任何 Key 都不得打印、写日志、落文件或回传客户端**——本模块
 * 只输出 `capabilities`（来源枚举），绝不带 Key 值。
 */
import type { CapabilitySource, HelloKeys, SessionCapabilities } from "@mira/protocol";
import { createDeepSeekLlm } from "./adapters/deepseek/deepseekLlm";
import { withSttErrorDegrade } from "./adapters/fish/degrade";
import { createFishStt } from "./adapters/fish/fishStt";
import { createFishTts } from "./adapters/fish/fishTts";
import { createImageGenMedia, defaultOutDir, type ImageGenOptions } from "./adapters/media/imageGen";
import { createMockLlm } from "./adapters/mock/mockLlm";
import { createMockSceneWriter } from "./adapters/mock/mockSceneWriter";
import { createMockStt } from "./adapters/mock/mockStt";
import { createMockTts } from "./adapters/mock/mockTts";
import { createPresetMedia } from "./adapters/media/presetMedia";
import type { ServerConfig, ProviderCredentials } from "./config";
import type { Logger } from "./log";
import type { LLMPort, MediaPort, Ports, SceneWriterPort, STTPort, TTSPort } from "./ports";
import { withPaceCheck } from "./quality/paceGuard";
import { createSceneWriter } from "./scene/writer";
import type { SceneRunnerDeps } from "./scene/runner";

/** 请求的模式：`auto` 由规则判定，`mock` / `real` 为显式指定。 */
export type RequestedMode = "mock" | "real" | "auto";

/**
 * 一类 Key 的统一视图：访问者提供的优先，否则用服务端的。
 * `source` 说明来源（不含任何 Key 值本身），供 `capabilities` 使用。
 */
export type KeyChoice = { value: string; source: CapabilitySource };

/** 组装一套适配器所需的 Key（已按「访问者优先，否则服务端」解析）。 */
export type ProvidersKeys = {
  deepseek: KeyChoice;
  fish: KeyChoice;
  /** 访问者覆盖的音色（缺省时为空串，沿用服务端角色包音色）。 */
  fishVoiceIdUser: string;
  image: KeyChoice & { baseUrl: string; model: string };
};

/** 工厂产出的完整适配器集合。 */
export type BuiltProviders = {
  ports: Ports;
  sceneWriter: SceneWriterPort;
  sceneImageGen: SceneRunnerDeps["image"] | undefined;
  /** 剧情层媒体端口（真实生图或预置照片）。 */
  media: MediaPort;
};

/** 取字符串并去首尾空白；非字符串按空串处理。 */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * §1 纯函数：把「访问者提供的 Key」与「服务端 `.env` 的 Key」合成一类 `KeyChoice`。
 * 访问者提供的非空值优先，否则服务端的；两边都没有 → `{ value: "", source: "none" }`。
 */
export function chooseKey(userValue: unknown, serverValue: string): KeyChoice {
  const user = text(userValue);
  if (user !== "") return { value: user, source: "user" };
  const server = serverValue.trim();
  if (server !== "") return { value: server, source: "server" };
  return { value: "", source: "none" };
}

/** §1 纯函数：解析一组 Key（访问者优先，否则服务端）。 */
export function resolveKeys(keys: HelloKeys | undefined, server: ProviderCredentials): ProvidersKeys {
  return {
    deepseek: chooseKey(keys?.deepseek?.apiKey, server.deepseek.apiKey),
    fish: chooseKey(keys?.fish?.apiKey, server.fish.apiKey),
    fishVoiceIdUser: text(keys?.fish?.voiceId),
    image: {
      ...chooseKey(keys?.image?.apiKey, server.image.apiKey),
      baseUrl: text(keys?.image?.baseUrl),
      model: text(keys?.image?.model),
    },
  };
}

/** §2 纯函数：real 模式要求 LLM 与语音都有可用 Key。缺哪一类由返回值说明（空数组 = 都有）。 */
export function missingForReal(resolved: ProvidersKeys): Array<"llm" | "voice"> {
  const missing: Array<"llm" | "voice"> = [];
  if (resolved.deepseek.value === "") missing.push("llm");
  if (resolved.fish.value === "") missing.push("voice");
  return missing;
}

/**
 * §2 纯函数：模式判定。
 * - `auto`：LLM 与语音都有可用 Key → real，否则 mock；
 * - `real`：显式要求 real；缺 Key 时返回 `{ mode: "real", missing: [...] }`（调用方据此报错）；
 * - `mock`：始终 mock（不读 Key）。
 */
export function resolveMode(requested: RequestedMode, resolved: ProvidersKeys): { mode: "mock" | "real"; missing: Array<"llm" | "voice"> } {
  if (requested === "mock") return { mode: "mock", missing: [] };
  const missing = missingForReal(resolved);
  if (requested === "real") return { mode: "real", missing };
  return { mode: missing.length === 0 ? "real" : "mock", missing: [] };
}

/** §2 纯函数：各类能力的来源。mock 模式下 LLM / 语音都按 `none` 上报（不读 Key）。 */
export function computeCapabilities(mode: "mock" | "real", resolved: ProvidersKeys): SessionCapabilities {
  if (mode === "mock") return { llm: "none", voice: "none", image: resolved.image.source };
  return { llm: resolved.deepseek.source, voice: resolved.fish.source, image: resolved.image.source };
}

/** 组装工厂入参。 */
export type BuildProvidersOptions = {
  mode: "mock" | "real";
  /** 已解析的 Key（访问者优先，否则服务端）。 */
  keys: ProvidersKeys;
  /**
   * 服务端 `.env` 凭据（结构字段 baseUrl / model / 默认音色的来源）。
   * 与 `keys` 的 source 无关——即使 server 在 mock 模式（`config.providers` 为空），这里也拿到真实 baseUrl。
   */
  serverCredentials: ProviderCredentials;
  /** 服务端配置（Mock 语音清单、预置照片延时等非凭据字段）。 */
  serverConfig: ServerConfig;
  logger: Logger;
  /** 环境变量（生图输出目录用），默认 process.env。 */
  env?: NodeJS.ProcessEnv;
};

/**
 * §1 工厂：按 `mode` + `keys` 组装一套适配器。
 * - mock：全部走 Mock（无状态，可全局共享，不读任何 Key）；
 * - real：LLM 走 DeepSeek，STT/TTS 走 Fish，场景扩写复用 LLM provider，生图在 image Key 可用时走真实端点。
 *   某一类缺 Key 时**不静默降级**——real 所需的关键 Key 已在上层判定（auto/real 规则）保证。
 */
export function buildProviders(options: BuildProvidersOptions): BuiltProviders {
  const { mode, keys, serverConfig, serverCredentials, logger } = options;
  const env = options.env ?? process.env;
  const log = logger;

  if (mode === "mock") {
    return {
      ports: {
        stt: createMockStt(),
        llm: createMockLlm(),
        tts: createMockTts({ manifestPath: serverConfig.voiceManifestPath, log }),
      },
      sceneWriter: createMockSceneWriter(),
      sceneImageGen: undefined,
      media: createPresetMedia({
        delayMs: serverConfig.mediaPresetDelayMs,
        basePath: "/characters/yuna",
        videoBasePath: "/characters/yuna",
      }),
    };
  }

  // ---- real ----
  const stt: STTPort = withSttErrorDegrade(
    createFishStt({ baseUrl: serverCredentials.fish.baseUrl, apiKey: keys.fish.value, log }),
    { log },
  );

  const llm: LLMPort = createDeepSeekLlm({
    baseUrl: serverCredentials.deepseek.baseUrl,
    apiKey: keys.deepseek.value,
    model: serverCredentials.deepseek.model,
    log,
  });

  const tts: TTSPort = withPaceCheck(
    createFishTts({
      baseUrl: serverCredentials.fish.baseUrl,
      apiKey: keys.fish.value,
      // 默认音色置空 —— 真实音色由会话层按角色包经 TtsOptions.voiceId 注入（S6b-fix1 §1）。
      voiceId: serverCredentials.fish.voiceId,
      model: serverCredentials.fish.ttsModel,
      log,
    }),
    { log },
  );

  const sceneWriter = createSceneWriter({
    provider: "deepseek",
    deepseek: serverCredentials.deepseek,
    log,
  });

  // 生图参数：访问者自带 Key 时用访问者的 baseUrl / model，否则用服务端配置。
  const imageBaseUrl = keys.image.baseUrl !== "" ? keys.image.baseUrl : serverCredentials.image.baseUrl;
  const imageModel = keys.image.model !== "" ? keys.image.model : serverCredentials.image.model;
  const imageKey = keys.image.value;
  const imageGenOpts: Omit<ImageGenOptions, "prompt" | "size" | "media" | "signal"> | undefined =
    imageKey !== ""
      ? {
          baseUrl: imageBaseUrl,
          apiKey: imageKey,
          model: imageModel,
          outDir: defaultOutDir(env),
          log: (event, detail) => log({ ts: Date.now(), event, detail }),
        }
      : undefined;

  const media: MediaPort = imageGenOpts
    ? createImageGenMedia({
        baseUrl: imageGenOpts.baseUrl,
        apiKey: imageGenOpts.apiKey,
        model: imageGenOpts.model,
        outDir: imageGenOpts.outDir,
        log: imageGenOpts.log,
      })
    : createPresetMedia({
        delayMs: serverConfig.mediaPresetDelayMs,
        basePath: "/characters/yuna",
        videoBasePath: "/characters/yuna",
      });

  return { ports: { stt, llm, tts }, sceneWriter, sceneImageGen: imageGenOpts, media };
}

/**
 * §2 / §3：一次 hello 的模式与 Key 决策结果（纯函数产出，不含适配器）。
 * - `ok: false`：显式请求 real 但缺 LLM / 语音 Key → 上层回 `error{code:"real_unavailable"}`。
 */
export type SessionPlan =
  | {
      ok: true;
      mode: "mock" | "real";
      capabilities: SessionCapabilities;
      /** 访问者覆盖的音色（空串 = 沿用服务端角色包音色）。 */
      voiceIdUser: string;
      /** 已解析的 Key（真实模式构建适配器用；mock 模式不读）。 */
      keys: ProvidersKeys;
    }
  | { ok: false; missing: Array<"llm" | "voice"> };

/** §2 纯函数：由 hello 的 `mode` / `keys` + 服务端 `.env` 凭据判定模式与 capabilities。 */
export function planSession(
  mode: RequestedMode,
  keys: HelloKeys | undefined,
  server: ProviderCredentials,
): SessionPlan {
  const resolved = resolveKeys(keys, server);
  const { mode: actual, missing } = resolveMode(mode, resolved);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    mode: actual,
    capabilities: computeCapabilities(actual, resolved),
    voiceIdUser: resolved.fishVoiceIdUser,
    keys: resolved,
  };
}
