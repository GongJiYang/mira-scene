/**
 * S6b §2：情景化兜底（客户端部分）。
 *
 * 服务端能发消息的四类（stt_empty / stt_failed / llm_timeout / turn_failed）由服务端下发 beat；
 * **offline 只能由客户端本地播放**——WebSocket 断开时服务端发不出任何东西。
 *
 * 规则（用户要求）：
 * - 断线 / 重连中播一次「……喂？好像断线了。」（台词来自角色包，通过 `offlineLine` 注入）；
 * - 重连成功后**不重复播放**；同一次断线期间也只播一次；
 * - 语音用预录音频 `public/characters/<id>/voice/fallback/offline.mp3`；
 *   文件不存在时只显示字幕，不报错。
 *
 * 纯函数 `offlineDecision` 负责「这次状态变化要不要播」，便于单测；播放外壳在 `installOfflineFallback`。
 */
import { create } from "zustand";
import { pushEvent, useConnectionStore, type ConnectionStatus } from "./store";

/** 兜底字幕（客户端本地显示，与服务端 beat 无关）。 */
type FallbackSlice = { subtitle: string | null };

export const useFallbackStore = create<FallbackSlice>()(() => ({ subtitle: null }));

export type OfflineState = {
  /** 本次断线是否已经播过（重连成功后复位）。 */
  played: boolean;
};

export const initialOfflineState: OfflineState = { played: false };

export type OfflineDecision = { play: boolean; state: OfflineState };

/**
 * 纯函数：连接状态变化 → 是否播放 offline 兜底。
 *
 * - `reconnecting` 且本次断线还没播过 → 播一次，并置 `played`；
 * - `open` → 复位 `played`（下次断线可以再播一次），本次不播；
 * - `connecting` → 不播（首次连接不算断线）。
 */
export function offlineDecision(state: OfflineState, status: ConnectionStatus): OfflineDecision {
  if (status === "open") return { play: false, state: { played: false } };
  if (status === "reconnecting") {
    if (state.played) return { play: false, state };
    return { play: true, state: { played: true } };
  }
  return { play: false, state };
}

/** 兜底语音的本地路径（S6b §2 / §5 的放置约定）。 */
export function fallbackVoiceUrl(characterId: string, category: string): string {
  return `/characters/${characterId}/voice/fallback/${category}.mp3`;
}

/** 连接状态的最小可订阅接口（生产用 useConnectionStore，测试可注入假实现）。 */
export type ConnectionStatusStore = {
  getState(): { status: ConnectionStatus };
  subscribe(listener: (slice: { status: ConnectionStatus }) => void): () => void;
};

export type OfflineFallbackDeps = {
  /** 当前角色 id（决定语音路径）。 */
  characterId: () => string;
  /** 该角色的 offline 台词（来自角色包；由调用方注入，避免客户端复制台词）。 */
  offlineLine: () => string;
  /** 播放本地音频；文件缺失时静默返回（只显示字幕）。 */
  playAudio: (url: string) => void;
  /** 显示字幕。 */
  showSubtitle: (text: string | null) => void;
  log?: (event: string) => void;
  /** 连接状态来源；缺省用全局 useConnectionStore。 */
  store?: ConnectionStatusStore;
};

/**
 * 订阅连接状态，按 `offlineDecision` 播放 offline 兜底。
 * 返回取消订阅函数。
 */
export function installOfflineFallback(deps: OfflineFallbackDeps): () => void {
  let state = initialOfflineState;

  const apply = (status: ConnectionStatus): void => {
    const decision = offlineDecision(state, status);
    state = decision.state;
    if (!decision.play) {
      if (status === "open") deps.showSubtitle(null);
      return;
    }
    const line = deps.offlineLine();
    deps.showSubtitle(line);
    deps.playAudio(fallbackVoiceUrl(deps.characterId(), "offline"));
    deps.log?.(`offline fallback · ${line}`);
  };

  const store = deps.store ?? useConnectionStore;
  apply(store.getState().status);
  return store.subscribe((slice) => apply(slice.status));
}

/** 播放一段本地音频；失败（404 / 解码失败 / 无 AudioContext）静默忽略。 */
export function playLocalAudio(url: string): void {
  if (typeof AudioContext === "undefined") return;
  try {
    const context = new AudioContext();
    void fetch(url)
      .then((response) => (response.ok ? response.arrayBuffer() : null))
      .then((buffer) => (buffer === null ? null : context.decodeAudioData(buffer)))
      .then((decoded) => {
        if (decoded === null) return;
        const source = context.createBufferSource();
        source.buffer = decoded;
        source.connect(context.destination);
        source.start();
      })
      .catch(() => undefined);
  } catch {
    // 文件不存在或浏览器不允许：只保留字幕（S6b §2）。
  }
}

/** 把 offline 兜底接到全局 store（由 controller 的 bootstrap 调用）。 */
export function installOfflineFallbackFor(characterId: () => string, offlineLine: () => string): () => void {
  return installOfflineFallback({
    characterId,
    offlineLine,
    playAudio: playLocalAudio,
    showSubtitle: (text) => useFallbackStore.setState({ subtitle: text }),
    log: (event) => pushEvent(event),
  });
}
