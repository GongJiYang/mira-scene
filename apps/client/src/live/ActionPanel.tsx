/**
 * S6m §3 / S6u §2：主界面「动作表」面板（可收起，按 ActionPanel.dc.html 重做）。
 *
 * - 桌面：放在弹幕窗口（`.live-chat`）顶部的一个可展开标签（默认收起）。
 * - 手机：由 `entries.tsx` 的 `MobileMenu` 里「动作表」项触发，点开为底部抽屉。
 *
 * 点一下 = **只在本地预览**（不改 reducer 的 `visual`、不发网络、不算一轮），
 * 合成在渲染外壳里由纯函数 `composePreview` 完成。忧奈在 thinking / speaking 时整组禁用。
 *
 * 文案全部来自 `uiText.ts`（铁律 4）。
 */
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { usePreviewStore, previewDisabled, previewDurationSec, type PreviewItem } from "./previewStore";
import { ACTION_LABELS, UI_TEXT } from "./uiText";
import type { StagePhase } from "../view/useStageViewModel";
import type { Accent, Emotion } from "@mira/protocol";
import type { LocalActionId } from "../render/live2d/localActions";

// §4.4：只列画面上可区分的情绪。`neutral` 与 `calm` 等价（EMOTION_PARAMS 均为空），
// `surprised` 被 toYunaEmotion 映射到 `calm` → 二者删掉，不再出现在动作表。
const EMOTIONS = ["calm", "guarded", "sad", "warm"] as const satisfies readonly Emotion[];
const ACCENTS = [
  "love",
  "heart",
  "shy",
  "amazed",
  "cry",
  "angry",
  "black",
  "dark",
  "fly_head",
  "fly_pet",
] as const satisfies readonly Accent[];
const EXISTING_ACTIONS = ["drink", "glance", "phone", "show_item"] as const;
const LOCAL_ACTIONS = ["wave", "tail_wag", "ear_flick", "sway"] as const satisfies readonly LocalActionId[];

const emotionItem = (value: Emotion): PreviewItem => ({ kind: "emotion", value });
const accentItem = (value: Accent): PreviewItem => ({ kind: "accent", value });
const actionItem = (value: string): PreviewItem => ({ kind: "action", value: value as never });

/** 预览高亮的剩余秒数：从时长倒数，每 250ms 刷新一次。 */
function usePreviewCountdown(item: PreviewItem | null, startedAtMs: number): { value: string | null; remaining: number } {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (item === null) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(timer);
  }, [item]);
  if (item === null) return { value: null, remaining: 0 };
  const total = previewDurationSec(item);
  const elapsed = (nowMs() - startedAtMs) / 1000;
  const remaining = Math.max(0, Math.ceil(total - elapsed));
  return { value: item.value, remaining };
}

/**
 * 动作表按钮网格（分组）。桌面标签与手机抽屉共用。
 * `phase` 决定整组是否禁用；`onPick` 触发预览。预览中的项高亮并显示剩余秒数。
 */
export function ActionButtons({ phase, onPick }: { phase: StagePhase; onPick: (item: PreviewItem) => void }) {
  const disabled = previewDisabled(phase);
  const previewItem = usePreviewStore((state) => state.item);
  const previewStartedAtMs = usePreviewStore((state) => state.startedAtMs);
  const { value: activeValue, remaining } = usePreviewCountdown(previewItem, previewStartedAtMs);

  const groups: Array<{ title: string; items: PreviewItem[]; grid?: string }> = [
    { title: UI_TEXT.actionGroupEmotion, items: EMOTIONS.map(emotionItem) },
    { title: UI_TEXT.actionGroupAccent, items: ACCENTS.map(accentItem), grid: "5" },
    { title: UI_TEXT.actionGroupAction, items: EXISTING_ACTIONS.map((value) => actionItem(value)), grid: "4" },
    { title: UI_TEXT.actionGroupLocal, items: LOCAL_ACTIONS.map((value) => actionItem(value)), grid: "4" },
  ];

  return (
    <div className="action-groups" data-disabled={disabled ? "1" : "0"} aria-disabled={disabled}>
      {disabled && (
        <p className="action-disabled-note" data-testid="action-disabled-note">
          {UI_TEXT.actionSpeaking}
        </p>
      )}
      {groups.map((group) => (
        <div className="action-group" key={group.title} data-grid={group.grid}>
          <span className="action-group-title">{group.title}</span>
          <div className="action-buttons">
            {group.items.map((item) => {
              const id: string = item.value;
              const previewing = activeValue !== null && activeValue === id;
              return (
                <button
                  key={`${item.kind}-${id}`}
                  type="button"
                  className="action-button"
                  data-testid={`action-${id}`}
                  data-preview={previewing ? "1" : "0"}
                  disabled={disabled}
                  onClick={() => onPick(item)}
                >
                  {previewing ? `${ACTION_LABELS[id as keyof typeof ACTION_LABELS] ?? id} · ${remaining}s` : (ACTION_LABELS[id as keyof typeof ACTION_LABELS] ?? id)}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <p className="action-panel-note">{UI_TEXT.actionPanelNote}</p>
    </div>
  );
}

/** 桌面：弹幕窗口顶部的可展开标签（默认收起）。 */
export function ActionPanelDesktop({ phase }: { phase: StagePhase }) {
  const [open, setOpen] = useState(false);
  const startPreview = useStore(usePreviewStore, (state) => state.startPreview);

  const pick = (item: PreviewItem): void => {
    if (previewDisabled(phase)) return;
    startPreview(item, nowMs());
  };

  return (
    <div className="action-panel-desktop" data-testid="action-panel-wrap">
      <button
        type="button"
        className="action-panel-toggle"
        data-testid="action-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {UI_TEXT.actionPanel}
      </button>
      {open && (
        <div className="action-panel" data-testid="action-panel">
          <ActionButtons phase={phase} onPick={pick} />
        </div>
      )}
    </div>
  );
}

/** 手机：底部抽屉（由 MobileMenu 里的「动作表」项控制展开）。 */
export function ActionPanelMobile({ phase, open }: { phase: StagePhase; open: boolean }) {
  const startPreview = useStore(usePreviewStore, (state) => state.startPreview);
  const pick = (item: PreviewItem): void => {
    if (previewDisabled(phase)) return;
    startPreview(item, nowMs());
  };
  if (!open) return null;
  return (
    <div className="action-panel action-panel-mobile" data-testid="action-panel">
      <ActionButtons phase={phase} onPick={pick} />
    </div>
  );
}

/** 预览是否仍在进行（供 UI 高亮，可选）。 */
export function previewActiveNow(): boolean {
  const { item, startedAtMs } = usePreviewStore.getState();
  if (item === null) return false;
  return nowMs() - startedAtMs < previewDurationSec(item) * 1000;
}

function nowMs(): number {
  return typeof globalThis.performance !== "undefined" ? globalThis.performance.now() : Date.now();
}
