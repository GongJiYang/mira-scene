/**
 * Fish STT 适配器（§3）：调用 speech-to-text 接口，模型 `transcribe-1-pro`，语言 zh。
 * 上传时**原样转发浏览器录到的 mime**（P2 尚未实测，见报告里的不确定项）。
 *
 * 请求形态与仓库内 P2 探针一致（tools/probes/p2/probe.ts），仅把音频的 content-type
 * 由 `application/octet-stream` 换成浏览器实际录到的 mime。
 */
import type { Logger } from "../../log";
import type { AudioData, STTPort } from "../../ports";
import { FishApiError, fishErrorCodeForStatus } from "./errors";

export const FISH_STT_MODEL = "transcribe-1-pro";

export type FishSttOptions = {
  baseUrl: string;
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  log?: Logger;
};

export function createFishStt(options: FishSttOptions): STTPort {
  const doFetch = options.fetch ?? globalThis.fetch;
  const model = options.model ?? FISH_STT_MODEL;
  let creditExhausted = false;

  return {
    async transcribe(audio: AudioData, signal): Promise<string> {
      if (creditExhausted) throw new FishApiError("fish_credit", "Fish 余额不足，已跳过后续 STT 请求");

      const form = new FormData();
      form.append("audio", new Blob([new Uint8Array(audio.data)], { type: audio.mime }), "sample");
      form.append("ignore_timestamps", "true");
      form.append("language", "zh");

      options.log?.({ ts: Date.now(), event: "fish_call", detail: { port: "stt" } });
      const response = await doFetch(`${options.baseUrl}/asr`, {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          model,
        },
        body: form,
      });

      if (!response.ok) {
        const code = fishErrorCodeForStatus(response.status);
        const detail = await response.text().catch(() => "");
        if (code === "fish_credit") creditExhausted = true;
        if (code !== null) throw new FishApiError(code, `Fish STT 返回 ${response.status}`);
        throw new Error(`Fish STT 返回 ${response.status} ${detail.slice(0, 200)}`);
      }

      const parsed = (await response.json()) as { text?: unknown };
      return typeof parsed.text === "string" ? parsed.text : "";
    },
  };
}
