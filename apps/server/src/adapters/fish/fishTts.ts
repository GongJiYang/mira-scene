/**
 * Fish TTS 适配器（§3）：每个 beat 一次 HTTP 请求。
 *
 * 请求体字段与仓库内 P3 探针保持一致（tools/probes/p3/probe.ts），
 * 并按本阶段要求用 `latency: "balanced"`、`mp3_bitrate: 128`（供语速体检按 CBR 估算）。
 * 返回 `{ mime: "audio/mpeg", data }`。AbortSignal 直接透传给 fetch。
 */
import type { Logger } from "../../log";
import type { TTSAudio, TTSPort } from "../../ports";
import { FishApiError, fishErrorCodeForStatus } from "./errors";

export type FishTtsOptions = {
  /** 例如 `https://api.fish.audio/v1`。 */
  baseUrl: string;
  apiKey: string;
  /** 默认音色（S6b-fix1 §1：会话层会按角色包经 `TtsOptions.voiceId` 覆盖）。为空则不传 `reference_id`。 */
  voiceId: string;
  model: string;
  fetch?: typeof fetch;
  log?: Logger;
  mp3Bitrate?: number;
  /** 余额耗尽后允许再次探测真实请求的间隔（毫秒），默认 5 分钟。 */
  creditProbeIntervalMs?: number;
  /** 注入时钟（测试用），默认 `Date.now`。 */
  now?: () => number;
};

/** 余额耗尽后探测下一次真实请求的间隔（s3-fix §4）。 */
export const CREDIT_PROBE_INTERVAL_MS = 5 * 60 * 1000;

export function createFishTts(options: FishTtsOptions): TTSPort {
  const doFetch = options.fetch ?? globalThis.fetch;
  const mp3Bitrate = options.mp3Bitrate ?? 128;
  const probeIntervalMs = options.creditProbeIntervalMs ?? CREDIT_PROBE_INTERVAL_MS;
  const clock = options.now ?? Date.now;
  /**
   * s3-fix §4：余额耗尽的标记。
   * - 402 后置为「下次允许探测的时间点」，间隔内不再发请求，避免继续烧调用次数（≤8 上限）；
   * - 每 5 分钟允许探测一次真实请求；
   * - **成功请求一次之后自动清除**（`0` 表示当前允许请求）。
   */
  let creditExhaustedUntil = 0;

  return {
    async synthesize(text, opts, signal): Promise<TTSAudio> {
      if (creditExhaustedUntil !== 0 && clock() < creditExhaustedUntil) {
        throw new FishApiError("fish_credit", "Fish 余额不足，已跳过后续 TTS 请求");
      }

      // S6b-fix1 §1：音色按会话角色包决定（会话层经 TtsOptions.voiceId 传入）；
      // 缺省回落到构造时的默认 voiceId（兼容既有直接构造用法）。
      const voiceId = opts.voiceId ?? options.voiceId;
      const body: Record<string, unknown> = {
        text,
        format: "mp3",
        mp3_bitrate: mp3Bitrate,
        latency: "balanced",
      };
      if (voiceId !== "") body.reference_id = voiceId;

      options.log?.({ ts: Date.now(), event: "fish_call", detail: { port: "tts" } });
      const response = await doFetch(`${options.baseUrl}/tts`, {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          model: options.model,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const code = fishErrorCodeForStatus(response.status);
        const detail = await response.text().catch(() => "");
        if (code === "fish_credit") creditExhaustedUntil = clock() + probeIntervalMs;
        if (code !== null) throw new FishApiError(code, `Fish TTS 返回 ${response.status}`);
        throw new Error(`Fish TTS 返回 ${response.status} ${detail.slice(0, 200)}`);
      }

      // 成功请求一次即清除余额耗尽的标记（s3-fix §4）。
      creditExhaustedUntil = 0;

      const data = Buffer.from(await response.arrayBuffer());
      options.log?.({ ts: Date.now(), event: "tts_synthesized", detail: { bytes: data.byteLength } });
      return { mime: "audio/mpeg", data };
    },
  };
}
