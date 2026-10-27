import type { ServerMessage } from "@mira/protocol";
import { create } from "zustand";
import { getStageState, useStageStore } from "./store";
import {
  initialStoryMediaState,
  storyMediaReducer,
  type StoryMediaAction,
  type StoryMediaState,
} from "../state/storyMedia";

/**
 * 状态机 C 的接线：media_ready 不经过 A 的 turnId 过滤，直接进 C；
 * A 的 phase 变化只用于决定 ready → shown 的时机。
 */
export const useStoryMediaStore = create<StoryMediaState>()(() => initialStoryMediaState);

export function dispatchStoryMedia(action: StoryMediaAction): void {
  useStoryMediaStore.setState((state) => storyMediaReducer(state, action));
}

export function handleMediaReady(message: Extract<ServerMessage, { type: "media_ready" }>): void {
  const { storyEventId, media, status } = message.payload;
  dispatchStoryMedia(
    status === "ready" ? { type: "READY", storyEventId, media } : { type: "FALLBACK", storyEventId, media },
  );
}

/**
 * D27：带 media 的 beat 一到就向 C 登记显影请求。
 * 服务端的异步生成在 beat 产出时就已开始，客户端尽早登记可避免「ready 先于 REQUEST」的乱序。
 */
export function handleMediaRequest(storyEventId: string): void {
  dispatchStoryMedia({ type: "REQUEST", storyEventId });
}

/** 订阅 A 的 phase；返回取消订阅函数。 */
export function installStoryMediaLink(): () => void {
  dispatchStoryMedia({ type: "PHASE", phase: getStageState().phase.kind });
  return useStageStore.subscribe((state) => {
    dispatchStoryMedia({ type: "PHASE", phase: state.phase.kind });
  });
}
