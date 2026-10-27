/**
 * S6g-A §5：入口按钮——「文档」「观测」。
 *
 * - 桌面：放在直播间顶栏右侧（`.live-hud`）。
 * - 手机：收进顶栏右侧的可展开菜单（`.live-mobile-top`）。
 *
 * 文字全部来自 `uiText.ts`（铁律 6）。用 `<a href>` 保证可直接跳转、e2e 可断言。
 * 文档入口带上默认打开的路径（`docs/architecture/00-导读.md`）。
 */
import { useEffect, useRef, useState } from "react";
import { UI_TEXT } from "./uiText";
import type { StagePhase } from "../view/useStageViewModel";
import { ActionPanelMobile } from "./ActionPanel";

/** 文档窗口默认打开的文档（DocsApp 支持 `?docs=1&doc=<path>`）。 */
export const DOCS_URL = "?docs=1&doc=docs/architecture/00-%E5%AF%BC%E8%AF%BB.md";
/** 观测页入口。 */
export const OBS_URL = "?obs=1";

/** 桌面顶栏右侧的入口（两个文字链接）。 */
export function LiveEntries() {
  return (
    <div className="live-entries" data-testid="live-entries">
      <a className="live-entry" data-testid="entry-docs" href={DOCS_URL}>
        {UI_TEXT.docs}
      </a>
      <a className="live-entry" data-testid="entry-obs" href={OBS_URL}>
        {UI_TEXT.obs}
      </a>
    </div>
  );
}

/** 手机端可展开菜单：一个「☰」按钮 + 展开后的入口链接 + S6m §3 的「动作表」项。 */
export function MobileMenu({ phase }: { phase: StagePhase }) {
  const [open, setOpen] = useState(false);
  // S6m §3：菜单里的「动作表」点开为底部抽屉。
  const [actionOpen, setActionOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部收起菜单。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <>
      <div className="live-mobile-menu" data-testid="mobile-menu" ref={rootRef}>
        <button
          type="button"
          className="live-mobile-mic"
          data-testid="mobile-menu-toggle"
          aria-label={UI_TEXT.menu}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          ☰
        </button>
        {open && (
          <div className="live-mobile-menu-panel" data-testid="mobile-menu-panel">
            {/* S6m §3：打开动作表（底部抽屉）。 */}
            <button
              type="button"
              className="live-entry"
              data-testid="action-toggle"
              onClick={() => {
                setActionOpen(true);
                setOpen(false);
              }}
            >
              {UI_TEXT.actionPanel}
            </button>
            <a className="live-entry" data-testid="entry-docs" href={DOCS_URL}>
              {UI_TEXT.docs}
            </a>
            <a className="live-entry" data-testid="entry-obs" href={OBS_URL}>
              {UI_TEXT.obs}
            </a>
          </div>
        )}
      </div>
      {/* S6m §3：手机底部抽屉（含关闭按钮）。 */}
      {actionOpen && (
        <div className="action-panel-mobile-wrap" data-no-stage-tap>
          <button
            type="button"
            className="action-panel-close"
            data-testid="action-panel-close"
            aria-label={UI_TEXT.close}
            onClick={() => setActionOpen(false)}
          >
            {UI_TEXT.close}
          </button>
          <ActionPanelMobile phase={phase} open={actionOpen} />
        </div>
      )}
    </>
  );
}
