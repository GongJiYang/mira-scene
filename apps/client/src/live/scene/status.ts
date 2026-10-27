/**
 * S6c §5：换背景状态条（直播间 UI 右上角）。
 *
 * 状态来自服务端 `scene_status` 消息：`writing` / `generating` 显示转场状态条；
 * `ready` → 新背景 1.2 秒交叉淡入；`failed` / `rejected` / `busy` → 保持原背景。
 */
import { create } from "zustand";
import type { SceneStatusPayload } from "@mira/protocol";

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
};

export const useSceneStatusStore = create<SceneStatusSlice>()(() => ({
  display: { kind: "idle" },
  backgroundUrl: null,
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
        });
      }
      break;
    case "failed":
      useSceneStatusStore.setState({ display: { kind: "failed" } });
      break;
    case "rejected":
      useSceneStatusStore.setState({ display: { kind: "rejected" } });
      break;
    case "busy":
      useSceneStatusStore.setState({ display: { kind: "busy" } });
      break;
  }
}

/** 切频道时复位（由 controller 调用）。 */
export function resetSceneStatus(): void {
  useSceneStatusStore.setState({ display: { kind: "idle" }, backgroundUrl: null });
}
