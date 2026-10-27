/**
 * S6g-A §3.3：reveal 的「截图」弹窗（剧情层，D27）。
 *
 * 直播间里弹出的「截图」卡片，覆盖舞台一角（不是聊天气泡）。
 * 生成中 → 卡片内显示加载状态；`media_ready status=ready` → 显示生成图；
 * fallback / 失败 → 显示预置截图（`/characters/yuna/photo_first_stream.png`），**不提示错误**。
 *
 * 打断不撤销（D27）：数据来自状态机 C（storyMedia），不经 turnId；可点关闭。
 */
import { useEffect, useState } from "react";
import type { StoryMediaStatus } from "../state/storyMedia";
import { UI_TEXT } from "./uiText";

export type ScreenshotCardProps = {
  status: StoryMediaStatus;
  /** `media_ready` 给出的图片地址（ready 时）。 */
  url: string | null;
  /** fallback / 失败时的预置图。 */
  fallbackUrl: string;
};

/** 卡片在「可展示」的状态集合：developing 显示加载态；ready/shown 显示图；fallback 显示预置图。 */
const VISIBLE_STATUSES: readonly StoryMediaStatus[] = ["developing", "ready", "shown", "fallback"];

export function ScreenshotCard({ status, url, fallbackUrl }: ScreenshotCardProps) {
  const [dismissed, setDismissed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  // 新的 storyEventId / 状态变化时重新允许显示。
  useEffect(() => {
    setDismissed(false);
    setImageFailed(false);
  }, [status, url]);

  if (dismissed || !VISIBLE_STATUSES.includes(status)) return null;

  // fallback 或图片加载失败 → 预置图；ready/shown → 生成图。
  const source = status === "ready" || status === "shown" ? (url ?? fallbackUrl) : fallbackUrl;

  return (
    <div className="live-screenshot" data-testid="screenshot-card" data-status={status}>
      <button
        type="button"
        className="live-screenshot-close"
        data-testid="screenshot-close"
        aria-label={UI_TEXT.close}
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
      <span className="live-screenshot-label">{UI_TEXT.screenshot}</span>
      <div className="live-screenshot-frame">
        {status === "developing" ? (
          <span className="live-screenshot-loading" data-testid="screenshot-loading" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        ) : (
          // eslint-disable-next-line jsx-a11y/alt-text
          <img
            src={imageFailed ? fallbackUrl : source}
            alt=""
            data-testid="screenshot-image"
            onError={() => setImageFailed(true)}
          />
        )}
      </div>
    </div>
  );
}
