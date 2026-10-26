/**
 * 语速体检装饰器（§4）：合成后跑一次 `paceCheck`，超出正常范围就重试 1 次；
 * 仍然超出就保留这一段音频并写 warning（不降级成无声 beat）。
 *
 * 放在适配器外层而不是会话层：会话层本轮只允许接入提示词上下文、计时事件与
 * `playback_started`（架构关卡 §2），语速重试属于 TTS 适配器的职责。
 */
import { isAbortError } from "../abort";
import type { Logger } from "../log";
import type { TTSAudio, TTSPort } from "../ports";
import { DEFAULT_MP3_BITRATE_BPS, paceCheck } from "./paceCheck";

export type PaceGuardOptions = {
  log?: Logger;
  bitrate?: number;
};

export function withPaceCheck(tts: TTSPort, options: PaceGuardOptions = {}): TTSPort {
  const bitrate = options.bitrate ?? DEFAULT_MP3_BITRATE_BPS;

  function warn(cps: number, reason: string): void {
    options.log?.({ ts: Date.now(), event: "tts_pace_warning", detail: { cps, reason } });
  }

  return {
    ...tts,
    async synthesize(text, opts, signal): Promise<TTSAudio> {
      const first = await tts.synthesize(text, opts, signal);
      const firstCheck = paceCheck(text, first.data.byteLength, bitrate);
      if (firstCheck.ok) return first;

      // s3-fix §3：第一句（beatSeq === 0）不重试，避免拖慢 Q3 的首句延迟；
      // 只检查并写 warning，第二句及以后维持原逻辑。
      if (opts.beatSeq === 0) {
        warn(firstCheck.cps, "first_beat_no_retry");
        return first;
      }

      // 疑似漏读或杂音：重试 1 次。
      let second: TTSAudio;
      try {
        second = await tts.synthesize(text, opts, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        warn(firstCheck.cps, "retry_failed");
        return first;
      }

      const secondCheck = paceCheck(text, second.data.byteLength, bitrate);
      if (!secondCheck.ok) warn(secondCheck.cps, "still_out_of_range");
      return second;
    },
  };
}
