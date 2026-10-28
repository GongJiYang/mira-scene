import { create } from "zustand";
import { initialState, reducer, type ClientAction, type ClientState } from "../state";

/** S1 的 reducer 状态由 zustand 持有；dispatch 是唯一写入口。 */
export const useStageStore = create<ClientState>()(() => initialState);

export function dispatch(action: ClientAction): void {
  useStageStore.setState((state) => reducer(state, action));
}

export function getStageState(): ClientState {
  return useStageStore.getState();
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

type ConnectionSlice = {
  status: ConnectionStatus;
  sessionId: string | null;
  /** §5.1：会话创建时刻（服务端 epoch ms），用于顶栏真实开播时长；null 表示尚未收到。 */
  startedAt: number | null;
};

/** 连接状态独立 slice：不写进 reducer（D14）。 */
export const useConnectionStore = create<ConnectionSlice>()(() => ({
  status: "connecting",
  sessionId: null,
  startedAt: null,
}));

type MicSlice = { micError: string | null };

/** 麦克风错误独立 slice。 */
export const useMicStore = create<MicSlice>()(() => ({ micError: null }));

type DebugSlice = { events: string[] };

const MAX_DEBUG_EVENTS = 20;

/** 最近 20 条事件，只用于排查与占位 UI 的 debug 区。 */
export const useDebugStore = create<DebugSlice>()(() => ({ events: [] }));

export function pushEvent(event: string): void {
  useDebugStore.setState((state) => ({ events: [...state.events, event].slice(-MAX_DEBUG_EVENTS) }));
}
