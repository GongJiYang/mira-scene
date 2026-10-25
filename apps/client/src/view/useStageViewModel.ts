/**
 * 视图模型（D14）。这是给 UI 设计的唯一契约。
 *
 * 约束：UI 组件不得直接 import store、connection、audio —— 只能通过 useStageViewModel 读写。
 * G1-c 只新增字段（performance / storyMedia / pendingNudge），已有字段未改。
 */
import type { FaceLayers, Hands, Media } from "@mira/protocol";
import { useStore } from "zustand";
import { intents, useNudgeStore, type Intents } from "../core/controller";
import { usePerformanceStore } from "../core/performanceClock";
import {
  useConnectionStore,
  useDebugStore,
  useMicStore,
  useStageStore,
  type ConnectionStatus,
} from "../core/store";
import { useStoryMediaStore } from "../core/storyMediaLink";
import type { ClientState, Phase, Visual } from "../state";
import {
  initialPerformanceState,
  type ActiveAction,
  type Blink,
  type HandsTransition,
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

/** 状态机 B 的只读投影（D28）。 */
export type StagePerformance = {
  face: FaceLayers;
  blink: Blink;
  mouth: MouthShape;
  hands: Hands;
  handsTransition: HandsTransition | null;
  activeAction: ActiveAction | null;
  idleSince: number | null;
};

/** 状态机 C 的只读投影（D27）。 */
export type StageStoryMedia = {
  status: StoryMediaStatus;
  storyEventId: string | null;
  media: Media | null;
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
};

export type StageViewModel = StageView & { intents: Intents };

export type StageViewInput = {
  stage: ClientState;
  connection: ConnectionStatus;
  sessionId: string | null;
  micError: string | null;
  events: string[];
  performance?: PerformanceState;
  storyMedia?: StoryMediaState;
  pendingNudge?: boolean;
};

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
      face: performance.face,
      blink: performance.blink,
      mouth: performance.mouth,
      hands: performance.hands,
      handsTransition: performance.handsTransition,
      activeAction: performance.activeAction,
      idleSince: performance.idleSince,
    },
    storyMedia: {
      status: storyMedia.status,
      storyEventId: storyMedia.storyEventId,
      media: storyMedia.media,
    },
    pendingNudge: input.pendingNudge ?? false,
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

  return {
    ...toStageView({ stage, connection, sessionId, micError, events, performance, storyMedia, pendingNudge }),
    intents,
  };
}
