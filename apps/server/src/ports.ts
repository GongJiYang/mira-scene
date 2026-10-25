import type { Emotion, SceneState } from "@mira/protocol";

export type AudioData = { mime: string; data: Buffer };

export type LLMHistoryEntry = { role: "user" | "assistant"; text: string };

export type LLMContext = {
  history: LLMHistoryEntry[];
  scene: SceneState;
  userText: string;
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

export type TTSPort = {
  synthesize(text: string, opts: { emotion: Emotion }, signal: AbortSignal): Promise<TTSAudio>;
};

export type Ports = {
  stt: STTPort;
  llm: LLMPort;
  tts: TTSPort;
};
