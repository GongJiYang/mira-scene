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
  /** 照片槽位：显影生命周期、当前展示的媒体。空白相纸只在这里出现。 */
  status: StoryMediaStatus;
  storyEventId: string | null;
  media: Media | null;
  /** 视频槽位（S6a §3）：与照片槽位相互独立，视频不占用照片的槽位。 */
  video: StoryVideoSlot;
  /** storyEventId → 已处理到哪一步；命中的事件一律忽略。 */
  processed: Readonly<Record<string, StoryMediaMark>>;
  /** storyEventId → 媒体种类（REQUEST 时按 beat.media.type 登记）。 */
  kinds: Readonly<Record<string, MediaKind>>;
  /** A 的 phase 镜像：ready 到达时据此决定立即 shown 还是排队。 */
  phase: StagePhaseKind;
};

/** S6a §3：媒体种类，决定 REQUEST 落到照片槽位还是视频槽位。 */
export type MediaKind = "photo" | "video";

/** S6a §3：视频槽位。status 与照片槽位的 `StoryMediaStatus` 同形，便于复用展示条件。 */
export type StoryVideoSlot = {
  status: StoryMediaStatus;
  storyEventId: string | null;
  media: Media | null;
};

export type StoryMediaAction =
  | { type: "REQUEST"; storyEventId: string; kind: MediaKind }
  | { type: "READY"; storyEventId: string; media: Media }
  | { type: "FALLBACK"; storyEventId: string; media: Media }
  | { type: "IMAGE_FAILED"; storyEventId: string; media: Media }
  | { type: "PHASE"; phase: StagePhaseKind };

const EMPTY_VIDEO_SLOT: StoryVideoSlot = { status: "none", storyEventId: null, media: null };

export const initialStoryMediaState: StoryMediaState = {
  status: "none",
  storyEventId: null,
  media: null,
  video: EMPTY_VIDEO_SLOT,
  processed: {},
  kinds: {},
  phase: "idle",
};

/** ready → shown 的条件：A 不处于 speaking / listening（D28）。 */
function isShowable(phase: StagePhaseKind): boolean {
  return phase !== "speaking" && phase !== "listening";
}

function mark(state: StoryMediaState, storyEventId: string, status: StoryMediaMark): Record<string, StoryMediaMark> {
  return { ...state.processed, [storyEventId]: status };
}

/* ------------------------------------------------------------------------------------------------
 * S5 §5：剧情视频（状态机 C 的视频子状态，纯 reducer）。
 *
 * 与照片的区别（D34 的明确例外）：照片打断后保留，视频打断**就结束**、不恢复。
 * 契约（架构关卡 §4）：
 * 1. 同一时刻最多只有一个视频在播；
 * 2. 任何状态下，turnId 已失效（不是 A 的当前轮）的视频都不得出现。
 * ---------------------------------------------------------------------------------------------- */

export type VideoStatus = "idle" | "loading" | "playing" | "ended" | "failed" | "dismissed";

export type VideoState = {
  status: VideoStatus;
  /** 视频事件的 storyEventId（同时用作 `<video>` 的 key 与去重依据）。 */
  eventId: string | null;
  /** 视频所属轮次。 */
  turnId: number | null;
  /** A 的当前轮次镜像：与 `turnId` 不符的视频不得出现。 */
  currentTurnId: number;
  /** 视频地址。 */
  url: string | null;
  /** 失败时的不打断提示。 */
  notice: string | null;
};

export type VideoAction =
  | { type: "LOAD"; eventId: string; turnId: number; url: string }
  | { type: "CANPLAY"; eventId: string }
  | { type: "ENDED"; eventId: string }
  | { type: "ERROR"; eventId: string }
  | { type: "TIMEOUT"; eventId: string }
  | { type: "TURN"; turnId: number };

export const initialVideoState: VideoState = {
  status: "idle",
  eventId: null,
  turnId: null,
  currentTurnId: 0,
  url: null,
  notice: null,
};

/** 失败提示（不打断体验，§5）。 */
export const VIDEO_FAILED_NOTICE = "视频暂时放不出来，先看一张照片吧";

/** 视频层是否可见：只有 `playing` 才出现（loading 时舞台照常）。 */
export function isVideoVisible(state: VideoState): boolean {
  return state.status === "playing";
}

/** 视频是否仍在其所属轮次里推进（loading / playing）。 */
export function isVideoActive(state: VideoState): boolean {
  return state.status === "loading" || state.status === "playing";
}

/** 视频所属轮次是否已失效（A 已经进入更新的轮次）。 */
export function isVideoStale(state: VideoState): boolean {
  return state.turnId !== null && state.turnId !== state.currentTurnId;
}

/**
 * 视频状态转移（§5 的四种情况 + 失败）：
 * - LOAD：视频事件到达 → loading（同一事件只处理一次：打断后不复活；迟到的旧轮次直接忽略）；
 * - CANPLAY：loading → playing（淡入覆盖角色区域，字幕照常）；
 * - ENDED：playing → ended（淡出，回到常驻角色）；
 * - INTERRUPT 由 `TURN` 表达：A 进入新轮次 → loading/playing 直接 dismissed（立即结束，不恢复）；
 * - ERROR / TIMEOUT：loading/playing → failed（视频不出现，改显示静态图 + 提示）。
 */
export function videoReducer(state: VideoState, action: VideoAction): VideoState {
  switch (action.type) {
    case "LOAD": {
      if (state.eventId === action.eventId) return state;
      if (action.turnId < state.currentTurnId) return state;
      return {
        status: "loading",
        eventId: action.eventId,
        turnId: action.turnId,
        currentTurnId: action.turnId,
        url: action.url,
        notice: null,
      };
    }
    case "CANPLAY": {
      if (state.eventId !== action.eventId || state.status !== "loading" || isVideoStale(state)) return state;
      return { ...state, status: "playing" };
    }
    case "ENDED": {
      if (state.eventId !== action.eventId || state.status !== "playing") return state;
      return { ...state, status: "ended" };
    }
    case "ERROR":
    case "TIMEOUT": {
      if (state.eventId !== action.eventId) return state;
      if (state.status !== "loading" && state.status !== "playing") return state;
      return { ...state, status: "failed", notice: VIDEO_FAILED_NOTICE };
    }
    case "TURN": {
      if (state.currentTurnId === action.turnId) return state;
      const dismissed = isVideoActive(state) && state.turnId !== action.turnId;
      return { ...state, currentTurnId: action.turnId, status: dismissed ? "dismissed" : state.status };
    }
  }
}

/** `<sessionId>:<turn>:<seq>` → turn；解析失败返回 null。 */
export function turnIdFromStoryEventId(storyEventId: string): number | null {
  const parts = storyEventId.split(":");
  if (parts.length < 3) return null;
  const turn = Number(parts[1]);
  return Number.isInteger(turn) && turn >= 0 ? turn : null;
}

export function storyMediaReducer(state: StoryMediaState, action: StoryMediaAction): StoryMediaState {
  switch (action.type) {
    case "REQUEST": {
      if (state.processed[action.storyEventId]) return state;
      const kinds: Record<string, MediaKind> = { ...state.kinds, [action.storyEventId]: action.kind };

      // S6a §3：视频请求不落照片槽位 —— 不显影空白相纸、也不覆盖 reveal 的照片。
      if (action.kind === "video") {
        return {
          ...state,
          kinds,
          video: { status: "developing", storyEventId: action.storyEventId, media: null },
          processed: mark(state, action.storyEventId, "developing"),
        };
      }

      // 照片：一次只显影一张：上一张还在显影 / 排队时，新的请求丢弃（S4 才会有并发剧情事件）。
      if (state.status !== "none" && state.status !== "shown") return state;
      return {
        ...state,
        kinds,
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

      // S6a §3：视频事件落视频槽位，照片槽位保持不变（reveal 的照片因此保留）。
      if (state.kinds[action.storyEventId] === "video") {
        const active = state.video.status === "developing" || state.video.status === "ready" || state.video.status === "fallback";
        if (active && state.video.storyEventId !== action.storyEventId) return state;
        const arrived: StoryMediaMark = action.type === "READY" ? "ready" : "fallback";
        const videoStatus: StoryMediaStatus = isShowable(state.phase) ? "shown" : arrived;
        return {
          ...state,
          video: { status: videoStatus, storyEventId: action.storyEventId, media: action.media },
          processed: mark(state, action.storyEventId, videoStatus === "shown" ? "shown" : arrived),
        };
      }

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
    case "IMAGE_FAILED": {
      // Q8：正在展示的那张图片加载失败 → 换另一张预置照片继续显影（状态保持 shown）。
      // 只处理当前这张；其它 storyEventId 的失败回调忽略。
      if (state.status !== "shown" || state.storyEventId !== action.storyEventId) return state;
      return {
        ...state,
        media: action.media,
        processed: mark(state, action.storyEventId, "fallback"),
      };
    }
    case "PHASE": {
      if (state.phase === action.phase) return state;
      const showable = isShowable(action.phase);

      // 视频槽位：ready / fallback → shown（thinking 期间也可以显影，D28 补充）。
      const video =
        (state.video.status === "ready" || state.video.status === "fallback") &&
        showable &&
        state.video.storyEventId !== null
          ? { ...state.video, status: "shown" as StoryMediaStatus }
          : state.video;

      if (
        (state.status === "ready" || state.status === "fallback") &&
        showable &&
        state.storyEventId !== null
      ) {
        return {
          ...state,
          video,
          status: "shown",
          phase: action.phase,
          processed: mark(state, state.storyEventId, "shown"),
        };
      }
      return { ...state, video, phase: action.phase };
    }
  }
}
