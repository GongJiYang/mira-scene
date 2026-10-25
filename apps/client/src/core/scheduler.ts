import { nextBeatToPlay, type ClientState } from "../state";

export type PlayableBeat = { seq: number; silent: boolean };

/**
 * 纯函数：决定下一个可播放的 beat。
 * - 正在播放 → null
 * - phase 不是 thinking / speaking → null
 * - 没有待播 beat → null
 * - 无声 beat 不等音频
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
  return readySeqs.has(next.seq) ? { seq: next.seq, silent: false } : null;
}
