/**
 * S6c §5：换背景状态条（直播间 UI 右上角）。
 *
 * 状态来自服务端 `scene_status` 消息：`writing` / `generating` 显示转场状态条；
 * `ready` → 新背景 1.2 秒交叉淡入；`failed` / `rejected` / `busy` → 保持原背景。
 */
import { create } from "zustand";
import type { SceneStatusPayload } from "@mira/protocol";
import { characterOrDefault } from "../characters";
import { useChannelStore } from "../channel";
import { enqueueSceneFallback } from "./sceneFallback";

/** 状态条显示状态。 */
export type SceneStatusDisplay =
  | { kind: "idle" }
  | { kind: "writing" }
  | { kind: "generating"; label?: string }
  | { kind: "ready"; label: string; urls: { desktop: string; mobile: string } }
  | { kind: "failed" }
  | { kind: "rejected" }
  | { kind: "busy" };

type SceneStatusSlice = {
  display: SceneStatusDisplay;
  /** 当前生效的背景（初始为角色包默认背景，ready 后换成新背景）。 */
  backgroundUrl: { desktop: string; mobile: string } | null;
  /**
   * S6l-fix1 §2：本次背景是「直接切换」（刷新恢复）还是「交叉淡入」（实时换背景成功）。
   * `true` 时 Live 跳过淡入动画，直接显示。
   */
  direct: boolean;
};

export const useSceneStatusStore = create<SceneStatusSlice>()(() => ({
  display: { kind: "idle" },
  backgroundUrl: null,
  direct: false,
}));

/** 处理服务端 scene_status 消息（由 connection 调用）。 */
export function handleSceneStatus(payload: SceneStatusPayload): void {
  switch (payload.status) {
    case "writing":
      useSceneStatusStore.setState({ display: { kind: "writing" } });
      break;
    case "generating":
      useSceneStatusStore.setState({ display: { kind: "generating", label: payload.label } });
      break;
    case "ready":
      if (payload.urls !== undefined) {
        useSceneStatusStore.setState({
          display: { kind: "ready", label: payload.label ?? "", urls: payload.urls },
          backgroundUrl: payload.urls,
          direct: false,
        });
      }
      break;
    case "failed":
      useSceneStatusStore.setState({ display: { kind: "failed" } });
      // S6c-fix1 §2：失败 / 拒绝的兜底属于剧情层——在角色不说话的空档播放本地预录兜底 + 字幕。
      if (payload.category === "scene_failed") {
        enqueueSceneFallback("scene_failed", characterOrDefault(useChannelStore.getState().characterId).sceneFallbackLines.scene_failed);
      }
      break;
    case "rejected":
      useSceneStatusStore.setState({ display: { kind: "rejected" } });
      if (payload.category === "scene_rejected") {
        enqueueSceneFallback("scene_rejected", characterOrDefault(useChannelStore.getState().characterId).sceneFallbackLines.scene_rejected);
      }
      break;
    case "busy":
      useSceneStatusStore.setState({ display: { kind: "busy" } });
      break;
  }
}

/**
 * S6l-fix1 §2：刷新恢复——直接切到该背景。
 * 走 scene_status ready 的同一套「应用背景」逻辑（设置 backgroundUrl），但：
 * - 不显示「生成中」状态条（display 保持 idle）；
 * - 标记 `direct: true`，Live 据此跳过交叉淡入动画。
 */
export function applyResumeBackground(urls: { desktop: string; mobile: string }): void {
  useSceneStatusStore.setState({ backgroundUrl: urls, direct: true });
}

/** 切频道时复位（由 controller 调用）。 */
export function resetSceneStatus(): void {
  useSceneStatusStore.setState({ display: { kind: "idle" }, backgroundUrl: null, direct: false });
}
