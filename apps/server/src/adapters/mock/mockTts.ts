import { sleep, throwIfAborted } from "../../abort";
import type { TTSAudio, TTSPort } from "../../ports";

export const WAV_MIME = "audio/wav";
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
};

export function createMockTts(options: MockTtsOptions = {}): TTSPort {
  const delayMs = options.delayMs ?? 200;

  return {
    async synthesize(text, _opts, signal): Promise<TTSAudio> {
      await sleep(delayMs, signal);
      throwIfAborted(signal);
      return { mime: WAV_MIME, data: synthesizeWav(text) };
    },
  };
}
