import type { Emotion, Media, SceneState } from "@mira/protocol";

export type AudioData = { mime: string; data: Buffer };

export type LLMHistoryEntry = { role: "user" | "assistant"; text: string };

export type LLMContext = {
  history: LLMHistoryEntry[];
  scene: SceneState;
  userText: string;
  /**
   * D32：这一轮是主动开口（nudge）。提示词据此追加「对方沉默了一会儿」的提示；
   * 会话层同时会禁止本轮推进剧情，因此不计入 trust。
   */
  nudge?: boolean;
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
 * 媒体端口（D27 · 端口/适配器）。
 * 本批只实现「预置照片」：等待一段可配置的时长后返回可访问地址，
 * 模拟后台异步生成。真实生图适配器以后新增，核心不变。
 */
export type MediaPort = {
  preset(media: Media, signal: AbortSignal): Promise<PresetMediaResult>;
};
