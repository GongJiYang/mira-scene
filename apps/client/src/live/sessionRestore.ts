/**
 * S6l-fix1 §2：刷新恢复（客户端）。
 *
 * 刷新后客户端用 `sessionStorage` 的 `mira.sessionId` 恢复会话；服务端在 `session` 消息里
 * 下发 `background`（当前生成背景）与 `transcript`（最近对话）。这里把它们落到客户端：
 * - 背景：直接切到该背景（走 scene_status ready 的同一套应用逻辑，但不播「生成中」状态与切换动画）；
 * - 弹幕：只把 `role:"user"` 的条目按顺序恢复（显示为「你」发的弹幕，样式与平时一致）；
 *   assistant 条目不进弹幕区（字幕不恢复，避免刷新后突然出现旧字幕）。
 *
 * 纯数据落在 store / reducer 里，便于单测；`Live.tsx` 订阅 `useSessionRestoreStore` 排空。
 */
import { create } from "zustand";
import type { SessionPayload } from "@mira/protocol";
import { applyResumeBackground } from "./scene/status";

type SessionRestoreSlice = {
  /** 待恢复进弹幕的用户历史消息（Live 排空后清空）。 */
  userLines: string[];
};

export const useSessionRestoreStore = create<SessionRestoreSlice>()(() => ({ userLines: [] }));

/** 处理带 background / transcript 的 session 消息（由 connection 调用）。 */
export function applySessionRestore(payload: Pick<SessionPayload, "background" | "transcript">): void {
  if (payload.background !== undefined && payload.background !== null) {
    applyResumeBackground(payload.background.urls);
  }
  const lines = (payload.transcript ?? [])
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.text);
  if (lines.length > 0) {
    useSessionRestoreStore.setState({ userLines: lines });
  }
}

/** 排空待恢复的用户弹幕（Live 消费后调用）。返回后清空。 */
export function drainRestoredUserLines(): string[] {
  const lines = useSessionRestoreStore.getState().userLines;
  if (lines.length > 0) useSessionRestoreStore.setState({ userLines: [] });
  return lines;
}
