/**
 * S6m §3：主界面「动作表」的**本地预览**状态（客户端独立状态）。
 *
 * 点一下动作表里的一项 = 只在本地预览，**不发服务端、不算一轮、不影响剧情与导演层冷却**。
 * 预览不改 reducer 的 `visual`（A 状态机不动），渲染时由纯函数 `composePreview` 合成：
 * 预览优先于当前待机视觉。
 *
 * 时长规则（§3）：
 * - 情绪：保持 3s 后恢复；
 * - 表情：按 accent 规则渐入 0.4s → 保持 → 渐出 0.4s（总保持 2s）；
 * - 动作：按其时长（现有动作取 `SILENT_ACTION_TABLE.durationSec`；新动作取 `LOCAL_ACTION_DURATION_SEC`）。
 *
 * `thinking` / `speaking` 时整组按钮禁用（`previewDisabled`）；预览进行中若来了新一轮输入或
 * beat，由渲染外壳调用 `endPreview()` 立即结束（渐出）。
 */
import { create } from "zustand";
import type { Accent, Emotion } from "@mira/protocol";
import type { YunaEmotion } from "../render/live2d/yunaParams";
import { SILENT_ACTION_TABLE } from "../render/live2d/yunaParams";
import { LOCAL_ACTION_DURATION_SEC, localActionSample, type LocalActionId } from "../render/live2d/localActions";
import { postPhysicsParams, type PostPhysicsOverride } from "../render/live2d/postPhysics";
import { ACCENT_FADE_SEC, accentParams } from "../render/live2d/accentParams";
import { toYunaEmotion } from "./emotionMap";
import type { StagePhase } from "../view/useStageViewModel";
import type { Visual } from "../state";

/** 预览项（互斥，同一时刻只有一个）。情绪用协议名（含 surprised），合成时再映射到模型情绪。 */
export type PreviewItem =
  | { kind: "emotion"; value: Emotion }
  | { kind: "accent"; value: Accent }
  | { kind: "action"; value: LocalActionId | keyof typeof SILENT_ACTION_TABLE };

/** 情绪预览时长（秒）。 */
export const PREVIEW_EMOTION_SEC = 3;
/** 表情预览「保持」时长（秒）；前后各有 `ACCENT_FADE_SEC` 渐入 / 渐出。 */
export const PREVIEW_ACCENT_HOLD_SEC = 2;

/** 预览项时长（秒）。动作按各自时长。 */
export function previewDurationSec(item: PreviewItem): number {
  switch (item.kind) {
    case "emotion":
      return PREVIEW_EMOTION_SEC;
    case "accent":
      return PREVIEW_ACCENT_HOLD_SEC;
    case "action":
      return item.value in LOCAL_ACTION_DURATION_SEC
        ? LOCAL_ACTION_DURATION_SEC[item.value as LocalActionId]
        : SILENT_ACTION_TABLE[item.value as keyof typeof SILENT_ACTION_TABLE].durationSec;
  }
}

/** `thinking` / `speaking` 时整组按钮禁用（§3）。 */
export function previewDisabled(phase: StagePhase): boolean {
  return phase === "thinking" || phase === "speaking";
}

type PreviewSlice = {
  item: PreviewItem | null;
  startedAtMs: number;
  startPreview(item: PreviewItem, now: number): void;
  endPreview(): void;
};

export const usePreviewStore = create<PreviewSlice>()((set) => ({
  item: null,
  startedAtMs: 0,
  startPreview(item, now) {
    set({ item, startedAtMs: now });
  },
  endPreview() {
    set({ item: null, startedAtMs: 0 });
  },
}));

/**
 * `composePreview(base, preview, now)`：把预览合成到待机视觉上（§3 纯函数）。
 *
 * 返回：
 * - `emotion`：最终情绪（预览情绪优先，否则用 `base.emotion`）；
 * - `params`：额外叠加参数（表情 accent 的渐入渐出、sway 的物理输入），键值已截断；
 * - `postPhysics`：动作类预览的物理后覆盖（wave / tail_wag / ear_flick）；无则 undefined。
 *
 * `speaking` 时拒绝预览（返回原样）；预览到期（`now - startedAtMs ≥ 时长`）也返回原样（恢复到待机）。
 * **不改 `base.visual`**（A 状态机不受影响）。
 */
export type PreviewBase = { emotion: YunaEmotion; visual: Visual; phase: StagePhase };
export type PreviewComposition = {
  emotion: YunaEmotion;
  params: Record<string, number>;
  postPhysics?: PostPhysicsOverride;
};

export function composePreview(
  base: PreviewBase,
  preview: { item: PreviewItem | null; startedAtMs: number } | null,
  now: number,
): PreviewComposition {
  const neutral: PreviewComposition = { emotion: base.emotion, params: {} };
  if (preview === null || preview.item === null) return neutral;
  // speaking 时拒绝预览（说话中不允许预览）。
  if (base.phase === "speaking") return neutral;

  const elapsedSec = (now - preview.startedAtMs) / 1000;
  const item = preview.item;
  // 情绪预览：协议情绪名 → 模型情绪（surprised → calm，与 toYunaEmotion 一致）。
  if (item.kind === "emotion") {
    if (elapsedSec < 0 || elapsedSec >= PREVIEW_EMOTION_SEC) return neutral;
    return { emotion: toYunaEmotion(item.value), params: {} };
  }
  if (elapsedSec < 0) return neutral;

  if (item.kind === "accent") {
    // 渐入 0.4s → 保持 → 渐出 0.4s（总保持 PREVIEW_ACCENT_HOLD_SEC）。
    const hold = PREVIEW_ACCENT_HOLD_SEC;
    if (elapsedSec >= hold + ACCENT_FADE_SEC) return neutral;
    const until = elapsedSec >= hold ? ACCENT_FADE_SEC : undefined;
    const sinceSec = elapsedSec >= hold ? elapsedSec - hold : elapsedSec;
    const contribution = accentParams(item.value, sinceSec, until);
    return { emotion: base.emotion, params: contribution };
  }

  // 动作类：现有动作（drink/glance/phone/show_item）走 yunaParams 的 silentAction；
  // 新动作（wave/tail_wag/ear_flick/sway）走本地曲线 + 物理后覆盖。
  const action = item.value;
  if (action in LOCAL_ACTION_DURATION_SEC) {
    const sample = localActionSample(action as LocalActionId, elapsedSec);
    // 预览结束（越界）→ sample 为空、postPhysics 权重 0。
    const postPhysics = postPhysicsParams(action as LocalActionId, elapsedSec);
    return {
      emotion: base.emotion,
      params: sample.input,
      postPhysics: postPhysics.weight > 0 ? postPhysics : undefined,
    };
  }
  // 已有无声动作：不改情绪，靠 StageRenderer 传给 yunaParams 的 silentAction 驱动。
  return neutral;
}

