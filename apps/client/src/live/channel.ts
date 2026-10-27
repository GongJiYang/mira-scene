/**
 * 频道（当前角色）状态（S6b §4）。
 *
 * 只保存「当前看的是谁」；切换频道的副作用（结束当前会话、重新 hello、清空聊天记录）
 * 由 `core/controller.ts` 的 `switchChannel` 意图执行（D14：UI 只经由视图模型）。
 */
import { create } from "zustand";
import { DEFAULT_CHANNEL_ID } from "./characters";

type ChannelSlice = { characterId: string };

export const useChannelStore = create<ChannelSlice>()(() => ({ characterId: DEFAULT_CHANNEL_ID }));

export function setChannel(characterId: string): void {
  useChannelStore.setState({ characterId });
}

export function currentChannelId(): string {
  return useChannelStore.getState().characterId;
}
