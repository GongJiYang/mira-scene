/**
 * 视图模型（D14）。这是给 UI 设计的唯一契约。
 *
 * 约束：UI 组件不得直接 import store、connection、audio —— 只能通过 useStageViewModel 读写。
 */
import type { Media } from "@mira/protocol";
import { useStore } from "zustand";
import { intents, type Intents } from "../core/controller";
import {
  useConnectionStore,
  useDebugStore,
  useMicStore,
  useStageStore,
  type ConnectionStatus,
} from "../core/store";
import type { ClientState, Phase, Visual } from "../state";

export type StagePhase = Phase["kind"];

export type StageError = { code: string; message: string; retryable: boolean };

export type StageView = {
  phase: StagePhase;
  visual: Visual;
  subtitle: string | null;
  media: Media | null;
  error: StageError | null;
  connection: ConnectionStatus;
  micError: string | null;
  debug: { turnId: number; sessionId: string | null; lastEvents: string[] };
};

export type StageViewModel = StageView & { intents: Intents };

export type StageViewInput = {
  stage: ClientState;
  connection: ConnectionStatus;
  sessionId: string | null;
  micError: string | null;
  events: string[];
};

/** 纯映射：可单测，不依赖 React。 */
export function toStageView(input: StageViewInput): StageView {
  const { stage } = input;
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
  };
}

export function useStageViewModel(): StageViewModel {
  const stage = useStore(useStageStore, (state) => state);
  const connection = useStore(useConnectionStore, (state) => state.status);
  const sessionId = useStore(useConnectionStore, (state) => state.sessionId);
  const micError = useStore(useMicStore, (state) => state.micError);
  const events = useStore(useDebugStore, (state) => state.events);

  return { ...toStageView({ stage, connection, sessionId, micError, events }), intents };
}
