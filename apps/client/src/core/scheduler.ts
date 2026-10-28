import { nextBeatToPlay, type ClientState } from "../state";

export type PlayableBeat = { seq: number; silent: boolean };

/** freeze-fix5 §2.1：无声 beat 的可读下限 / 上限（毫秒）。 */
export const SILENT_BEAT_MIN_MS = 1_500;
export const SILENT_BEAT_MAX_MS = 6_000;
/** 每个可读字符的停留时长（中文约 220ms/字）。 */
const SILENT_BEAT_MS_PER_CHAR = 220;

/**
 * freeze-fix5 §2.1：无声 beat（TTS 降级为无语音）的停留时长。
 *
 * 按可读速度计算：中文按字数，约 220ms/字；标点、空白不计。
 * 夹到 [1_500, 6_000]ms——短句至少停留 1.5s，长句最多 6s。
 * 纯函数，便于单测。
 */
export function silentBeatMs(text: string): number {
  const chars = [...text].filter((char) => !/\s/.test(char) && !/\p{P}/u.test(char)).length;
  const raw = chars * SILENT_BEAT_MS_PER_CHAR;
  return Math.min(SILENT_BEAT_MAX_MS, Math.max(SILENT_BEAT_MIN_MS, raw));
}

/** freeze-fix5 §2.2：本轮 TTS 已降级（服务端不会再发该轮的 tts_audio）。 */
export function isTurnTtsDegraded(state: ClientState): boolean {
  return state.ttsDegradedTurnId !== null && state.ttsDegradedTurnId === state.currentTurnId;
}

/**
 * 纯函数：决定下一个可播放的 beat。
 * - 正在播放 → null
 * - phase 不是 thinking / speaking → null
 * - 没有待播 beat → null
 * - 无声 beat 不等音频
 * - 本轮 TTS 降级（freeze-fix5 §2.2）：音频不会再来，未就绪的 beat 也按无声处理（不卡死）
 * - 有音频就绪才播，否则继续等待（保证 seq 顺序）
 */
export function pickNextPlayable(
  state: ClientState,
  readySeqs: ReadonlySet<number>,
  isPlaying: boolean,
): PlayableBeat | null {
  if (isPlaying) return null;
  if (state.phase.kind !== "thinking" && state.phase.kind !== "speaking") return null;

  const next = nextBeatToPlay(state);
  if (!next) return null;
  if (next.say === "") return { seq: next.seq, silent: true };
  if (readySeqs.has(next.seq)) return { seq: next.seq, silent: false };
  // 本轮已降级：这句不会有音频，按无声 beat 停留可读时长后结束。
  return isTurnTtsDegraded(state) ? { seq: next.seq, silent: true } : null;
}
