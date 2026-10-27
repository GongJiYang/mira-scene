/**
 * D49 / S6n §5：设置面板的数据层（纯函数 + localStorage）。
 *
 * 三组 Key（聊天 DeepSeek / 语音 Fish / 生图）保存在**这台设备的浏览器里**（`mira.settings`）；
 * 每次连接时随 hello 发给服务器使用，服务器不保存。空字符串的 Key 不发送。
 *
 * 约束（D14）：纯函数与存储在本模块；UI 只经由 store / 视图模型。
 */
import { create } from "zustand";

/** 模式三选一（`auto` 由服务端规则判定）。 */
export type RequestedMode = "auto" | "mock" | "real";

/** 设置里保存的三组 Key（全部可选，空串 = 未填）。 */
export type Settings = {
  mode: RequestedMode;
  deepseekKey: string;
  fishKey: string;
  fishVoiceId: string;
  imageKey: string;
  imageBaseUrl: string;
  imageModel: string;
};

export const DEFAULT_SETTINGS: Settings = {
  mode: "auto",
  deepseekKey: "",
  fishKey: "",
  fishVoiceId: "",
  imageKey: "",
  imageBaseUrl: "",
  imageModel: "",
};

/** localStorage 键。 */
export const SETTINGS_STORAGE_KEY = "mira.settings";

/** D49 / S6n §5：设置面板顶部说明（铁律 6：文案集中）。 */
export const SETTINGS_TEXT = {
  /** 入口按钮 / 面板标题。 */
  title: "设置",
  modeGroup: "模式",
  modeAuto: "自动",
  modeMock: "Mock",
  modeReal: "真实",
  /** 顶栏模式小标签。 */
  badgeMock: "Mock",
  badgeReal: "真实",
  llmGroup: "聊天",
  voiceGroup: "语音",
  imageGroup: "生图",
  deepseekKey: "DeepSeek API Key",
  fishKey: "Fish API Key",
  fishVoiceId: "音色 ID（可选）",
  imageKey: "生图 API Key",
  imageBaseUrl: "Base URL",
  imageModel: "模型（可选）",
  show: "显示",
  hide: "隐藏",
  save: "保存并重新连接",
  clear: "清除我的 Key",
  /** 来源标签（来自 session.capabilities）。 */
  sourceServer: "服务器已配置",
  sourceUser: "使用你填的",
  sourceNone: "未配置",
  /** §5：一行说明。 */
  privacyNote: "Key 只保存在这台设备的浏览器里，每次连接时发给服务器使用，服务器不保存。",
  /** §2：real 缺 Key 时客户端提示（自动回落 mock）。 */
  realUnavailable: "真实模式缺少聊天 / 语音的 Key，已切回 Mock",
  /** §3：Fish Key 用不了当前音色时的客户端提示（引导填自己的音色 ID）。 */
  voiceUnavailable: "这个 Fish Key 用不了忧奈的音色，可以在设置里填自己的音色 ID",
} as const;

/** 只保留三选一里的合法值；非法 / 缺省 → `auto`。 */
export function normalizeMode(value: unknown): RequestedMode {
  return value === "mock" || value === "real" ? value : "auto";
}

/**
 * §5 纯函数：模式三选一 → hello 的 `mode`。
 * `auto` / `mock` / `real` 原样下发（服务端按规则判定 auto）。
 */
export function resolveRequestedMode(settings: Settings): RequestedMode {
  return normalizeMode(settings.mode);
}

/** 去首尾空白后的字符串；空 → undefined（不发送）。 */
function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * §5 纯函数：设置 → hello 的 `keys` 载荷。空字符串的 Key 不发送；
 * 三组都为空时整体返回 undefined（不下发 keys 字段）。
 */
export function helloKeysFrom(settings: Settings): {
  deepseek?: { apiKey: string };
  fish?: { apiKey: string; voiceId?: string };
  image?: { apiKey: string; baseUrl: string; model?: string };
} | undefined {
  const deepseekKey = nonEmpty(settings.deepseekKey);
  const fishKey = nonEmpty(settings.fishKey);
  const fishVoiceId = nonEmpty(settings.fishVoiceId);
  const imageKey = nonEmpty(settings.imageKey);
  const imageBaseUrl = nonEmpty(settings.imageBaseUrl);
  const imageModel = nonEmpty(settings.imageModel);

  const keys: {
    deepseek?: { apiKey: string };
    fish?: { apiKey: string; voiceId?: string };
    image?: { apiKey: string; baseUrl: string; model?: string };
  } = {};
  if (deepseekKey !== undefined) keys.deepseek = { apiKey: deepseekKey };
  if (fishKey !== undefined) keys.fish = fishVoiceId === undefined ? { apiKey: fishKey } : { apiKey: fishKey, voiceId: fishVoiceId };
  // 生图：baseUrl 必填（服务端 schema 要求）；缺 apiKey 或 baseUrl 都不发送该类。
  if (imageKey !== undefined && imageBaseUrl !== undefined) {
    keys.image = imageModel === undefined ? { apiKey: imageKey, baseUrl: imageBaseUrl } : { apiKey: imageKey, baseUrl: imageBaseUrl, model: imageModel };
  }
  return keys.deepseek === undefined && keys.fish === undefined && keys.image === undefined ? undefined : keys;
}

/** 能力的来源（`session.capabilities` 的值）。 */
export type CapabilitySource = "user" | "server" | "none";

/** §5 纯函数：来源 → 中文标签。 */
export function capabilityLabel(source: CapabilitySource): string {
  if (source === "user") return SETTINGS_TEXT.sourceUser;
  if (source === "server") return SETTINGS_TEXT.sourceServer;
  return SETTINGS_TEXT.sourceNone;
}

/** 宽松解析从 localStorage 读到的值（任何字段非法都退回默认）。 */
function parseSettings(raw: unknown): Settings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_SETTINGS;
  const record = raw as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    mode: normalizeMode(record.mode),
    deepseekKey: str(record.deepseekKey),
    fishKey: str(record.fishKey),
    fishVoiceId: str(record.fishVoiceId),
    imageKey: str(record.imageKey),
    imageBaseUrl: str(record.imageBaseUrl),
    imageModel: str(record.imageModel),
  };
}

/** §5：读设置。读写都 try/catch，读不到当未填写。 */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    return parseSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** §5：写设置。失败静默（隐私模式）。 */
export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式下 localStorage 可能不可用：忽略。
  }
}

/** §5：清除本设备保存的 Key（保留模式选择）。 */
export function clearStoredKeys(settings: Settings): Settings {
  const next: Settings = { ...settings, deepseekKey: "", fishKey: "", fishVoiceId: "", imageKey: "", imageBaseUrl: "", imageModel: "" };
  saveSettings(next);
  return next;
}

type SettingsSlice = {
  settings: Settings;
  /** 本会话实际生效的模式（来自 `session.mode`）；null = 未连接。 */
  sessionMode: "mock" | "real" | null;
  /** 各类能力来源（来自 `session.capabilities`）。 */
  capabilities: { llm: CapabilitySource; voice: CapabilitySource; image: CapabilitySource } | null;
  update(next: Settings): void;
  clearKeys(): void;
  applySession(mode: "mock" | "real", capabilities: { llm: CapabilitySource; voice: CapabilitySource; image: CapabilitySource }): void;
};

/**
 * §5：设置状态（zustand）。初始值从 localStorage 读；`update` 同时落盘。
 * 组件订阅本 store；测试可直接改 state。
 */
export const useSettingsStore = create<SettingsSlice>()((set, get) => ({
  settings: loadSettings(),
  sessionMode: null,
  capabilities: null,
  update(next) {
    saveSettings(next);
    set({ settings: next });
  },
  clearKeys() {
    set({ settings: clearStoredKeys(get().settings) });
  },
  applySession(mode, capabilities) {
    set({ sessionMode: mode, capabilities });
  },
}));

/** 供 connection 读取当前设置（hello 用）。 */
export function currentSettings(): Settings {
  return useSettingsStore.getState().settings;
}
