import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sleep, throwIfAborted } from "../../abort";
import type { Logger } from "../../log";
import type { TTSAudio, TTSPort } from "../../ports";
import { voiceKey } from "./voiceKey";
import { clipsDirFor, loadVoiceManifest, type VoiceManifest } from "./voiceManifest";

export const WAV_MIME = "audio/wav";
/** 预录片段与 Fish 输出一致，都是 mp3。 */
export const MP3_MIME = "audio/mpeg";
const SAMPLE_RATE = 16_000;
const AMPLITUDE = 0.05;
const FREQUENCY_HZ = 220;
const MS_PER_CHAR = 180;
const MIN_DURATION_MS = 600;
const MAX_DURATION_MS = 6_000;

/**
 * 临时占位音频：16kHz 单声道 PCM16 WAV，220Hz 正弦音，振幅 0.05。
 * 时长 = clamp(字数 × 180ms, 600ms, 6000ms)。
 */
export function synthesizeWav(text: string): Buffer {
  const charCount = [...text].length;
  const durationMs = Math.min(Math.max(charCount * MS_PER_CHAR, MIN_DURATION_MS), MAX_DURATION_MS);
  const sampleCount = Math.round((durationMs * SAMPLE_RATE) / 1000);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.sin((2 * Math.PI * FREQUENCY_HZ * index) / SAMPLE_RATE) * AMPLITUDE;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }

  return buffer;
}

export type MockTtsOptions = {
  delayMs?: number;
  /**
   * 预录片段清单路径（S5 §1 方案 B）。提供时：
   * - 命中 `voiceKey(text, emotion)` → 返回预录 mp3；
   * - 未命中 → 退回占位音，并写一条 `voice_fallback` 日志（契约式降级，不算错误）。
   * manifest 不存在视为空表；存在但非法则**创建时**直接抛错（服务端启动即失败）。
   */
  manifestPath?: string;
  /** 记录 `voice_fallback`（缺省静默）。 */
  log?: Logger;
};

export function createMockTts(options: MockTtsOptions = {}): TTSPort {
  const delayMs = options.delayMs ?? 200;
  const log = options.log;
  const manifestPath = options.manifestPath;
  const manifest: VoiceManifest | null = manifestPath ? loadVoiceManifest(manifestPath) : null;
  const clipsDir = manifestPath ? clipsDirFor(manifestPath) : null;

  /** 命中预录片段时读取 mp3；文件缺失视为未命中。 */
  function readClip(file: string): Buffer | null {
    if (clipsDir === null) return null;
    const path = join(clipsDir, file);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  return {
    async synthesize(text, opts, signal): Promise<TTSAudio> {
      await sleep(delayMs, signal);
      throwIfAborted(signal);

      const key = voiceKey(text, opts.emotion);
      const clip = manifest?.clips[key];
      const data = clip ? readClip(clip.file) : null;
      if (data !== null) return { mime: MP3_MIME, data };

      // 契约（S5 §1）：查不到预录片段 → 降级为占位音 + 一条 voice_fallback 日志。
      log?.({ ts: Date.now(), event: "voice_fallback", detail: { voiceKey: key, emotion: opts.emotion } });
      return { mime: WAV_MIME, data: synthesizeWav(text) };
    },
  };
}
