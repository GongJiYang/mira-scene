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

/** 订阅 A 的 phase；返回取消订阅函数。 */
export function installStoryMediaLink(): () => void {
  dispatchStoryMedia({ type: "PHASE", phase: getStageState().phase.kind });
  return useStageStore.subscribe((state) => {
    dispatchStoryMedia({ type: "PHASE", phase: state.phase.kind });
  });
}
