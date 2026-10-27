/**
 * S6h §3：直播间首包延迟角标（`?hud=1`）。
 * 数据来自客户端自己测的「发出输入 → 第一段音频开始播放」（performance.now()），不依赖服务端。
 */
import { create } from "zustand";

type HudState = {
  /** 上一轮的首包延迟（ms）；undefined = 还没有。 */
  firstAudioMs: number | undefined;
};

export const useHudStore = create<HudState>()(() => ({ firstAudioMs: undefined }));

/** 由 connection 的 playback_started 回调写入。 */
export function recordFirstAudioMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  useHudStore.setState({ firstAudioMs: Math.round(ms) });
}

/** URL 带 `?hud=1` 时显示。 */
export function hudEnabled(): boolean {
  return new URLSearchParams(window.location.search).get("hud") === "1";
}
