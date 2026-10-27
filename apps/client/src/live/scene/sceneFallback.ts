/**
 * S6c-fix1 §2：换背景失败 / 拒绝的兜底（客户端剧情层）。
 *
 * 失败可能在 45–90 秒后才发生，此时用户可能已经发了新一轮。因此这类兜底**不再**用轮次 beat，
 * 而是由服务端在 `scene_status` 上带 `category`（`scene_failed` / `scene_rejected`）下发；
 * 客户端收到后：
 * - 角色**不说话**的空档（idle / listening）→ 播放本地预录兜底音频并显示字幕；
 * - 正在说话（thinking / speaking）→ 排队，等这轮结束再说；
 * - 被打断**不作废**（剧情层，与 D27 一致）。
 *
 * 预录音频路径沿用 `public/characters/<id>/voice/fallback/<category>.mp3`；
 * 文件不存在时只显示字幕，不报错（复用 fallback.ts 的 `playLocalAudio`）。
 *
 * 纯函数 `sceneFallbackDecision` 负责「现在这个 phase 要不要播」，便于单测。
 */
import { create } from "zustand";
import { fallbackVoiceUrl, playLocalAudio } from "../../core/fallback";
import { getStageState, pushEvent, useStageStore } from "../../core/store";
import type { StagePhaseKind } from "../../state/performance";

/** 待播放的兜底类别。 */
export type SceneFallbackCategory = "scene_failed" | "scene_rejected";

type SceneFallbackSlice = {
  /** 待播的兜底类别；null 表示无。 */
  pending: SceneFallbackCategory | null;
  /** 待显示的兜底字幕。 */
  subtitle: string | null;
};

export const useSceneFallbackStore = create<SceneFallbackSlice>()(() => ({ pending: null, subtitle: null }));

/** phase 是否处于「角色不说话」的空档。 */
export function isQuietPhase(phase: StagePhaseKind): boolean {
  return phase === "idle" || phase === "listening";
}

/**
 * 纯函数：给定当前 phase 与是否有待播兜底，决定是否现在播放。
 * `hasPending` 为 false → 不播；phase 不是空档 → 排队（不播、不清）。
 */
export function sceneFallbackDecision(phase: StagePhaseKind, hasPending: boolean): { play: boolean } {
  if (!hasPending) return { play: false };
  return { play: isQuietPhase(phase) };
}

/** 字幕/音频的显示外壳（由 install 注入，避免这里直接依赖 UI）。 */
type Sink = { showSubtitle: (text: string | null) => void; playAudio: (url: string) => void };
let sink: Sink = { showSubtitle: () => {}, playAudio: playLocalAudio };
const characterIdRef = { current: "yuna" };

/** 收到 failed / rejected 的 scene_status：登记待播（排队，等空档）。 */
export function enqueueSceneFallback(category: SceneFallbackCategory, line: string): void {
  useSceneFallbackStore.setState({ pending: category, subtitle: line });
  pushEvent(`scene fallback queued · ${category}`);
  tryPlaySceneFallback();
}

/** 若当前处于空档且有待播，则播放并清空。 */
export function tryPlaySceneFallback(): void {
  const state = useSceneFallbackStore.getState();
  const decision = sceneFallbackDecision(getStageState().phase.kind, state.pending !== null);
  if (!decision.play || state.pending === null) return;
  const category = state.pending;
  const line = state.subtitle ?? "";
  useSceneFallbackStore.setState({ pending: null });
  sink.playAudio(fallbackVoiceUrl(characterIdRef.current, category));
  sink.showSubtitle(line);
  pushEvent(`scene fallback played · ${category}`);
}

export type SceneFallbackDeps = {
  /** 当前角色 id（决定语音路径）。 */
  characterId: () => string;
  /** 显示字幕。 */
  showSubtitle: (text: string | null) => void;
  /** 播放本地音频（缺省用 fallback.ts 的 playLocalAudio）。 */
  playAudio?: (url: string) => void;
};

/** 订阅 A 的 phase：每次变化在空档播放待播的换背景兜底。返回取消订阅函数。 */
export function installSceneFallback(deps: SceneFallbackDeps): () => void {
  sink = { showSubtitle: deps.showSubtitle, playAudio: deps.playAudio ?? playLocalAudio };
  characterIdRef.current = deps.characterId();
  tryPlaySceneFallback();
  return useStageStore.subscribe(() => tryPlaySceneFallback());
}

/** 复位（切频道时）。 */
export function resetSceneFallback(): void {
  useSceneFallbackStore.setState({ pending: null, subtitle: null });
}
