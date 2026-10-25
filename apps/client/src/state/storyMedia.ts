import type { Media } from "@mira/protocol";
import type { StagePhaseKind } from "./performance";

/**
 * 状态机 C：剧情媒体（D27）。纯 reducer。
 * 显影生命周期与轮次无关：A 的打断 / 新一轮不会作废 C（只有 storyEventId 去重）。
 */
export type StoryMediaStatus = "none" | "developing" | "ready" | "shown" | "fallback";

/** 去重表里记录的状态（不含 none）。 */
export type StoryMediaMark = Exclude<StoryMediaStatus, "none">;

export type StoryMediaState = {
  status: StoryMediaStatus;
  storyEventId: string | null;
  media: Media | null;
  /** storyEventId → 已处理到哪一步；命中的事件一律忽略。 */
  processed: Readonly<Record<string, StoryMediaMark>>;
  /** A 的 phase 镜像：ready 到达时据此决定立即 shown 还是排队。 */
  phase: StagePhaseKind;
};

export type StoryMediaAction =
  | { type: "REQUEST"; storyEventId: string }
  | { type: "READY"; storyEventId: string; media: Media }
  | { type: "FALLBACK"; storyEventId: string; media: Media }
  | { type: "PHASE"; phase: StagePhaseKind };

export const initialStoryMediaState: StoryMediaState = {
  status: "none",
  storyEventId: null,
  media: null,
  processed: {},
  phase: "idle",
};

/** ready → shown 的条件：A 不处于 speaking / listening（D28）。 */
function isShowable(phase: StagePhaseKind): boolean {
  return phase !== "speaking" && phase !== "listening";
}

function mark(state: StoryMediaState, storyEventId: string, status: StoryMediaMark): Record<string, StoryMediaMark> {
  return { ...state.processed, [storyEventId]: status };
}

export function storyMediaReducer(state: StoryMediaState, action: StoryMediaAction): StoryMediaState {
  switch (action.type) {
    case "REQUEST": {
      if (state.processed[action.storyEventId]) return state;
      // 一次只显影一张：上一张还在显影 / 排队时，新的请求丢弃（S4 才会有并发剧情事件）。
      if (state.status !== "none" && state.status !== "shown") return state;
      return {
        ...state,
        status: "developing",
        storyEventId: action.storyEventId,
        media: null,
        processed: mark(state, action.storyEventId, "developing"),
      };
    }
    case "READY":
    case "FALLBACK": {
      // 去重只针对「已经到过 READY/FALLBACK」的事件；REQUEST 留下的 developing 标记不拦。
      const already = state.processed[action.storyEventId];
      if (already === "ready" || already === "shown" || already === "fallback") return state;
      const active =
        state.status === "developing" || state.status === "ready" || state.status === "fallback";
      // 另一张还在显影 / 排队：忽略，避免覆盖当前正在展示的那张。
      if (active && state.storyEventId !== action.storyEventId) return state;

      const arrived: StoryMediaMark = action.type === "READY" ? "ready" : "fallback";
      const status: StoryMediaStatus = isShowable(state.phase) ? "shown" : arrived;
      return {
        ...state,
        status,
        storyEventId: action.storyEventId,
        media: action.media,
        processed: mark(state, action.storyEventId, status === "shown" ? "shown" : arrived),
      };
    }
    case "PHASE": {
      if (state.phase === action.phase) return state;
      if (
        (state.status === "ready" || state.status === "fallback") &&
        isShowable(action.phase) &&
        state.storyEventId !== null
      ) {
        return {
          ...state,
          status: "shown",
          phase: action.phase,
          processed: mark(state, state.storyEventId, "shown"),
        };
      }
      return { ...state, phase: action.phase };
    }
  }
}
