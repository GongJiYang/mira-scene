/**
 * 视图模型（D14）。这是给 UI 设计的唯一契约。
 *
 * 约束：UI 组件不得直接 import store、connection、audio —— 只能通过 useStageViewModel 读写。
 * G1-c 只新增字段（performance / storyMedia / pendingNudge），已有字段未改。
 */
import type { Media, StoryNode } from "@mira/protocol";
import { useStore } from "zustand";
import { intents, reports, useNudgeStore, type Intents, type StageReports } from "../core/controller";
import { useFallbackStore } from "../core/fallback";
import { usePerformanceStore } from "../core/performanceClock";
import { useChannelStore } from "../live/channel";
import { DEFAULT_CHANNEL_ID } from "../live/characters";
import {
  useConnectionStore,
  useDebugStore,
  useMicStore,
  useStageStore,
  type ConnectionStatus,
} from "../core/store";
import { useStoryMediaStore } from "../core/storyMediaLink";
import { useSceneStatusStore } from "../live/scene/status";
import type { ClientState, Phase, Visual } from "../state";
import {
  initialPerformanceState,
  type ActiveAction,
  type Blink,
  type MouthShape,
  type PerformanceState,
} from "../state/performance";
import {
  initialStoryMediaState,
  type StoryMediaState,
  type StoryMediaStatus,
} from "../state/storyMedia";

export type StagePhase = Phase["kind"];

export type StageError = { code: string; message: string; retryable: boolean };

/** 状态机 B 的只读投影（D28）。D43：删除立绘用字段，只留 Live2D 消费的。 */
export type StagePerformance = {
  blink: Blink;
  mouth: MouthShape;
  activeAction: ActiveAction | null;
  idleSince: number | null;
};

/** 状态机 C 的只读投影（D27）。 */
export type StageStoryMedia = {
  status: StoryMediaStatus;
  storyEventId: string | null;
  media: Media | null;
  /** S6a §3：视频槽位（与照片槽位独立）。 */
  video: {
    status: StoryMediaStatus;
    storyEventId: string | null;
    media: Media | null;
  };
};

export type StageView = {
  phase: StagePhase;
  visual: Visual;
  subtitle: string | null;
  media: Media | null;
  error: StageError | null;
  connection: ConnectionStatus;
  micError: string | null;
  debug: { turnId: number; sessionId: string | null; lastEvents: string[] };
  performance: StagePerformance;
  storyMedia: StageStoryMedia;
  /** D32：12s 无输入产出的主动行动；本批不发送，S3 再接。 */
  pendingNudge: boolean;
  /** S6b §4：当前频道（角色包 id）。 */
  characterId: string;
  /** S6b §2：客户端本地兜底字幕（offline）；服务端兜底走 subtitle。 */
  fallbackSubtitle: string | null;
  /** S6b §2：原始错误信息只在 `?debug=1` 时显示。 */
  debugMode: boolean;
  /** S6c §5：换背景状态条（writing / generating / ready / failed / rejected / busy）。 */
  sceneStatus: { kind: string; label?: string };
  /** S6c §5：当前生效的背景（ready 后换成新背景；null 用角色包默认背景）。 */
  sceneBackground: { desktop: string; mobile: string } | null;
  /** S6l §2：当前剧情节点（只认服务端）。 */
  node: StoryNode;
};

export type StageViewModel = StageView & { intents: Intents; reports: StageReports };

export type StageViewInput = {
  stage: ClientState;
  connection: ConnectionStatus;
  sessionId: string | null;
  micError: string | null;
  events: string[];
  performance?: PerformanceState;
  storyMedia?: StoryMediaState;
  pendingNudge?: boolean;
  characterId?: string;
  fallbackSubtitle?: string | null;
  debugMode?: boolean;
  /** S6c §5：换背景状态条。 */
  sceneStatus?: { kind: string; label?: string };
  /** S6c §5：当前生效的背景。 */
  sceneBackground?: { desktop: string; mobile: string } | null;
};

/** S6b §2：`?debug=1` 才显示原始错误信息。 */
export function readDebugMode(search: string): boolean {
  const value = new URLSearchParams(search).get("debug");
  return value === "1" || value === "true";
}

/** 纯映射：可单测，不依赖 React。 */
export function toStageView(input: StageViewInput): StageView {
  const { stage } = input;
  const performance = input.performance ?? initialPerformanceState;
  const storyMedia = input.storyMedia ?? initialStoryMediaState;
  return {
    phase: stage.phase.kind,
    visual: stage.visual,
    subtitle: stage.subtitle,
    media: stage.media,
    error:
      stage.phase.kind === "error"
        ? { code: stage.phase.code, message: stage.phase.message, retryable: stage.phase.retryable }
        : null,
    connection: input.connection,
    micError: input.micError,
    debug: { turnId: stage.currentTurnId, sessionId: input.sessionId, lastEvents: input.events },
    performance: {
      blink: performance.blink,
      mouth: performance.mouth,
      activeAction: performance.activeAction,
      idleSince: performance.idleSince,
    },
    storyMedia: {
      status: storyMedia.status,
      storyEventId: storyMedia.storyEventId,
      media: storyMedia.media,
      video: {
        status: storyMedia.video.status,
        storyEventId: storyMedia.video.storyEventId,
        media: storyMedia.video.media,
      },
    },
    pendingNudge: input.pendingNudge ?? false,
    characterId: input.characterId ?? DEFAULT_CHANNEL_ID,
    fallbackSubtitle: input.fallbackSubtitle ?? null,
    debugMode: input.debugMode ?? false,
    sceneStatus: input.sceneStatus ?? { kind: "idle" },
    sceneBackground: input.sceneBackground ?? null,
    node: stage.node,
  };
}

export function useStageViewModel(): StageViewModel {
  const stage = useStore(useStageStore, (state) => state);
  const connection = useStore(useConnectionStore, (state) => state.status);
  const sessionId = useStore(useConnectionStore, (state) => state.sessionId);
  const micError = useStore(useMicStore, (state) => state.micError);
  const events = useStore(useDebugStore, (state) => state.events);
  const performance = useStore(usePerformanceStore, (state) => state);
  const storyMedia = useStore(useStoryMediaStore, (state) => state);
  const pendingNudge = useStore(useNudgeStore, (state) => state.pending);
  const characterId = useStore(useChannelStore, (state) => state.characterId);
  const fallbackSubtitle = useStore(useFallbackStore, (state) => state.subtitle);
  const sceneStatus = useSceneStatusStore((state) => state.display);
  const sceneBackground = useSceneStatusStore((state) => state.backgroundUrl);
  const debugMode = useDebugMode();

  return {
    ...toStageView({
      stage,
      connection,
      sessionId,
      micError,
      events,
      performance,
      storyMedia,
      pendingNudge,
      characterId,
      fallbackSubtitle,
      debugMode,
      sceneStatus,
      sceneBackground,
    }),
    intents,
    reports,
  };
}

/** `?debug=1` 只读一次（URL 不随交互变化）。 */
function useDebugMode(): boolean {
  return typeof window === "undefined" ? false : readDebugMode(window.location.search);
}
