import { sleep, throwIfAborted } from "../../abort";
import type { STTPort } from "../../ports";

const DEFAULT_TEXTS = ["你好", "你在等谁？", "别担心，我陪你等"];

export type MockSttOptions = {
  delayMs?: number;
  texts?: readonly string[];
};

/** 循环返回预设文本，延迟 400ms，响应 signal。 */
export function createMockStt(options: MockSttOptions = {}): STTPort {
  const delayMs = options.delayMs ?? 400;
  const texts = options.texts && options.texts.length > 0 ? options.texts : DEFAULT_TEXTS;
  let cursor = 0;

  return {
    async transcribe(_audio, signal) {
      await sleep(delayMs, signal);
      throwIfAborted(signal);
      const text = texts[cursor % texts.length] ?? "";
      cursor += 1;
      return text;
    },
  };
}
