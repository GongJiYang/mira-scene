/**
 * freeze-fix9 §3：语音输入识别结果进弹幕区。
 *
 * 服务端在 STT 成功后下发 `transcript { text }`（信封带本轮的 turnId，见 session.ts）。
 * 它必须像「用户自己发的弹幕」一样出现在弹幕区（kind = `transcript`，样式沿用 `user`），
 * 否则语音提问看起来像是没被听见。
 *
 * D3：只接受**当前轮**的 transcript；迟到旧轮的识别结果不得插入（turnId 不匹配即丢弃）。
 * 纯数据落在 store 里（便于单测）；`Live.tsx` 订阅后按轮次排空进弹幕 reducer。
 */
import { create } from "zustand";

type TranscriptSlice = {
  /** 待排空的识别结果（每条带收到时的 turnId）。 */
  pending: Array<{ turnId: number; text: string }>;
};

export const useTranscriptStore = create<TranscriptSlice>()(() => ({ pending: [] }));

/** 记录一条识别结果（由 connection 在收到 transcript 消息时调用；turnId 来自信封）。 */
export function recordTranscript(turnId: number, text: string): void {
  const trimmed = text.trim();
  if (trimmed === "") return;
  useTranscriptStore.setState((state) => ({ pending: [...state.pending, { turnId, text: trimmed }] }));
}

/**
 * 排空**当前轮**的识别结果（保留其它轮次待下次判定）。
 * 返回文本数组（供 danmaku reducer 追加）；返回后从 pending 移除。
 */
export function drainTranscripts(currentTurnId: number): string[] {
  const state = useTranscriptStore.getState();
  if (state.pending.length === 0) return [];
  const mine = state.pending.filter((entry) => entry.turnId === currentTurnId);
  if (mine.length === 0) return [];
  useTranscriptStore.setState({ pending: state.pending.filter((entry) => entry.turnId !== currentTurnId) });
  return mine.map((entry) => entry.text);
}
