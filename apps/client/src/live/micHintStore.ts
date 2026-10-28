/**
 * freeze-fix8 §2/§3：麦克风轻提示的视图状态（独立 slice，不写进 reducer）。
 *
 * 只保存「当前要显示的文案」，2 秒后自动清空。显示逻辑（.live-mic-hint）复用现有轻提示样式。
 * 计时用注入的时钟便于测试；默认用 `window.setTimeout`。
 */
import { create } from "zustand";

/** 轻提示显示时长（§2：2s）。 */
export const MIC_HINT_DURATION_MS = 2_000;

type MicHintSlice = { hint: string | null };

export const useMicHintStore = create<MicHintSlice>()(() => ({ hint: null }));

let timer: ReturnType<typeof setTimeout> | null = null;

/** 显示一条轻提示，`MIC_HINT_DURATION_MS` 后自动消失（新提示会重置计时）。 */
export function showMicHint(text: string): void {
  useMicHintStore.setState({ hint: text });
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    useMicHintStore.setState({ hint: null });
  }, MIC_HINT_DURATION_MS);
}

/** 立即清空（测试 / 卸载用）。 */
export function clearMicHint(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  useMicHintStore.setState({ hint: null });
}
