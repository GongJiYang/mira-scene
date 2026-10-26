/**
 * 语速体检（D30，架构关卡 §3 要求写成纯函数）。
 *
 * 按 CBR 位率估算 mp3 时长，算出「中文字数 ÷ 时长」，落在 2.6–8.5 字/秒之外
 * 判定为疑似漏读或杂音。少于 4 个字的句子不检查（§4）。
 * 只做计算，不重试、不打日志——重试由 `paceGuard` 负责。
 */

/** 按 CBR 128kbps 估算（§4），可用配置覆盖。 */
export const DEFAULT_MP3_BITRATE_BPS = 128_000;
export const MIN_CPS = 2.6;
export const MAX_CPS = 8.5;
/** 少于这个字数的句子不检查。 */
export const MIN_CHARS_FOR_CHECK = 4;

export type PaceResult = { ok: boolean; cps: number };

/** 去掉可能的 Fish 情绪标签与空白后，按 Unicode 字符计数。 */
export function countSpeakableChars(text: string): number {
  const withoutTag = text.replace(/^\s*\[[^\]]*\]\s*/, "");
  return [...withoutTag.replace(/\s+/g, "")].length;
}

export function paceCheck(text: string, bytes: number, bitrate: number = DEFAULT_MP3_BITRATE_BPS): PaceResult {
  const chars = countSpeakableChars(text);
  const durationSec = (bytes * 8) / bitrate;

  if (chars < MIN_CHARS_FOR_CHECK) {
    // 短句不检查，直接通过（cps 仍给出，便于日志观察）。
    return { ok: true, cps: durationSec > 0 ? chars / durationSec : 0 };
  }

  const cps = durationSec > 0 ? chars / durationSec : Number.POSITIVE_INFINITY;
  return { ok: cps >= MIN_CPS && cps <= MAX_CPS, cps };
}
