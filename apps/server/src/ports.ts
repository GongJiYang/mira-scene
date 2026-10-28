import type { Emotion, Media, SceneState } from "@mira/protocol";
import type { PromptPack } from "./prompts/renderPrompt";

export type AudioData = { mime: string; data: Buffer };

/**
 * S6l-fix2 §7：history 条目来源。
 * - `"user"`（缺省，兼容旧数据）：用户真实输入（文字 / 语音）；
 * - `"nudge"`：主动开口轮的占位（客户端那一句没有说话）；
 * - `"poke"` / `"gift"`：戳一下 / 送礼物的占位。
 * 只有 `source === "user"` 的用户条目算「用户说过话」。
 */
export type HistorySource = "user" | "nudge" | "poke" | "gift";

export type LLMHistoryEntry = { role: "user" | "assistant"; text: string; source?: HistorySource };

export type LLMContext = {
  history: LLMHistoryEntry[];
  scene: SceneState;
  userText: string;
  /**
   * S6b §1：本轮的激活角色包（提示词模板、节点文案、意图关键词都从这里取）。
   * 适配器不再持有单一提示词，从而同一适配器实例可服务多个角色。
   */
  pack: PromptPack;
  /**
   * D32：这一轮是主动开口（nudge）。提示词据此追加「对方沉默了一会儿」的提示；
   * 会话层同时会禁止本轮推进剧情，因此不计入 trust。
   */
  nudge?: boolean;
  /**
   * S6c §1：本轮弹幕命中「换背景」时，追加到 `scene_notes` 的提示
   * （「对方想换个背景，你这边正在换」）。角色照常回话，扩写与生图在后台进行。
   */
  sceneNotes?: string;
  /**
   * S6l §5：本轮输入类型。`text`（缺省）= 普通文字；`poke` = 戳一下；`gift` = 送礼物。
   * poke / gift 时 Mock 走 `pack.events` 情景回应；真实 LLM 由 `sceneNotes` 描述。
   */
  kind?: "text" | "poke" | "gift";
  /**
   * freeze-fix3 §3：本会话存在「已调度、未就绪」的剧情照片（仅 nudge 轮有意义）。
   * Mock 据此从 `pack.photoWaitingLines` 取铺垫台词。
   */
  photoWaiting?: boolean;
  /** freeze-fix3 §3：已铺垫次数，Mock 按此次序循环取 `photoWaitingLines`。 */
  photoWaitingIndex?: number;
};

/** 音频端口：方法都必须接收 AbortSignal。 */
export type STTPort = {
  transcribe(audio: AudioData, signal: AbortSignal): Promise<string>;
};

/**
 * LLM 端口：产出未经校验的原始对象（契约 ①：say / emotion / suggest / advance）。
 * 会话层先 `parseLlmBeatLenient` 降级，再交给导演层决定视觉。
 */
export type LLMPort = {
  streamBeats(ctx: LLMContext, signal: AbortSignal): AsyncIterable<unknown>;
};

export type TTSAudio = { mime: string; data: Buffer };

export type TtsOptions = {
  emotion: Emotion;
  /**
   * s3-fix §3：本句在整轮里的 `seq`（由会话层传入）。
   * `beatSeq === 0`（第一句）时语速体检只检查、不重试，避免拖慢首句延迟。
   */
  beatSeq?: number;
  /**
   * S6b-fix1 §1：TTS 音色按会话角色包决定。会话层从 `session.pack.voice.fishVoiceIdEnv`
   * 读到的环境变量值传入；真实 Fish 适配器据此作为 `reference_id`。
   */
  voiceId?: string;
  /**
   * S6b-fix1 §2：Mock TTS 按角色分目录查预录片段（`assets/voice/<characterId>/clips/`）。
   * 会话层传 `session.pack.id`。
   */
  characterId?: string;
};

export type TTSPort = {
  synthesize(text: string, opts: TtsOptions, signal: AbortSignal): Promise<TTSAudio>;
};

export type Ports = {
  stt: STTPort;
  llm: LLMPort;
  tts: TTSPort;
};

/** 预置媒体就绪结果：可访问地址 + 状态（生成失败时为 fallback）。 */
export type PresetMediaResult = { url: string; status: "ready" | "fallback" };

/**
 * S6b-fix1 §4：发起媒体任务时传给媒体端口的上下文。
 * `pack` 是当前会话的角色包（生图提示词模板来源），`history` 是最近对话（用于替换 `{{conversation}}`）。
 * `presetMedia` 忽略该上下文。
 */
export type MediaContext = {
  pack: import("./characters/pack").Pack;
  history: readonly LLMHistoryEntry[];
};

/**
 * 媒体端口（D27 · 端口/适配器）。
 * S6b-fix1 §4：`preset` 增加上下文参数，让生图提示词能用到当前对话。
 */
export type MediaPort = {
  preset(media: Media, ctx: MediaContext, signal: AbortSignal): Promise<PresetMediaResult>;
};

/**
 * S6c §2：场景扩写端口。
 * 把观众在弹幕里「换背景」的请求扩写成结构化场景描述（SceneSpec）或拒绝。
 * 实现：真实（复用 LLM 适配器，提示词用 `characters/<id>/scene.v1.md`）或 Mock（关键词查表）。
 */
export type SceneWriterPort = {
  write(ctx: SceneWriteContext, signal: AbortSignal): Promise<unknown>;
};

/** S6c §2：场景扩写的输入。 */
export type SceneWriteContext = {
  /** 当前会话的角色包（决定提示词与 Mock 查表）。 */
  pack: import("./characters/pack").Pack;
  /** 观众在弹幕里说的原话。 */
  userText: string;
  /** 当前剧情阶段 label（如「下播之后」）。 */
  nodeLabel: string;
  /** 当前背景描述（如「卧室」「咖啡馆」）。 */
  currentScene: string;
};
