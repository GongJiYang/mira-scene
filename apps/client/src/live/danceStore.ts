/**
 * 动作表「跳舞」的本地演出状态（客户端独立，不进协议、不影响剧情）。
 *
 * `active` 为真时舞台把常驻 Live2D 无缝切到 AI 舞蹈视频，播完或被打断后切回（见 `DanceLayer`）。
 */
import { create } from "zustand";

type DanceSlice = {
  active: boolean;
  start(): void;
  stop(): void;
};

export const useDanceStore = create<DanceSlice>()((set) => ({
  active: false,
  start() {
    set({ active: true });
  },
  stop() {
    set({ active: false });
  },
}));
