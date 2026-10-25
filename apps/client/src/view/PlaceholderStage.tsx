/**
 * UI 组件不得直接 import store、connection、audio —— 只能通过 useStageViewModel 读写。
 * 本文件仅做占位：纯文字、无视觉设计（D14；正式 UI 由用户另行设计）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useStageViewModel } from "./useStageViewModel";

export function PlaceholderStage() {
  const vm = useStageViewModel();
  const [draft, setDraft] = useState("");
  const holding = useRef(false);

  const startPushToTalk = useCallback(() => {
    if (holding.current) return;
    holding.current = true;
    vm.intents.pttDown();
  }, [vm.intents]);

  const endPushToTalk = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    vm.intents.pttUp();
  }, [vm.intents]);

  // 按钮外松开（pointerup / pointercancel）也要结束录音。
  useEffect(() => {
    window.addEventListener("pointerup", endPushToTalk);
    window.addEventListener("pointercancel", endPushToTalk);
    return () => {
      window.removeEventListener("pointerup", endPushToTalk);
      window.removeEventListener("pointercancel", endPushToTalk);
    };
  }, [endPushToTalk]);

  // 桌面端按住空格同样生效；输入框获得焦点时不触发。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 兼容 code 缺失的环境（如 PiP 注入事件）：空格键再用 key 兜底。
      if ((event.code !== "Space" && event.key !== " ") || event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      startPushToTalk();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") return;
      endPushToTalk();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [startPushToTalk, endPushToTalk]);

  const { phase, visual, subtitle, media, error, connection, micError, debug, performance, storyMedia, pendingNudge } = vm;

  return (
    <main>
      <p style={{ fontSize: "2rem", margin: 0 }}>{phase}</p>

      <p>{`emotion=${visual.emotion} hands=${visual.hands} action=${visual.action ?? "-"} camera=${
        visual.camera ?? "-"
      } fx=${visual.fx ?? "-"}`}</p>

      <p>{`performance: blink=${performance.blink} mouth=${performance.mouth} hands=${performance.hands} action=${
        performance.activeAction?.action ?? "-"
      } transition=${performance.handsTransition ? performance.handsTransition.progress.toFixed(2) : "-"}`}</p>

      <p>{`storyMedia=${storyMedia.status}${storyMedia.media ? ` ${storyMedia.media.type}:${storyMedia.media.id}` : ""}`}</p>
      {pendingNudge && <p>（她似乎想说点什么）</p>}

      <p>{`subtitle: ${subtitle ?? "-"}`}</p>

      {media && <p>{`[media: ${media.type} ${media.id}]`}</p>}

      <p>{`connection=${connection}`}</p>
      {micError && <p>{`麦克风不可用：${micError}`}</p>}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          vm.intents.submitText(draft);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="输入文字"
          aria-label="文字输入"
        />
        <button type="submit">发送</button>
      </form>

      <p>
        <button
          type="button"
          onPointerDown={startPushToTalk}
          onPointerUp={endPushToTalk}
          onPointerLeave={endPushToTalk}
          onPointerCancel={endPushToTalk}
        >
          按住说话
        </button>
        <span>（或按住空格）</span>
      </p>

      {error && (
        <section>
          <p>{`error ${error.code}: ${error.message}`}</p>
          <button type="button" onClick={vm.intents.retry}>
            重试
          </button>
        </section>
      )}

      <details>
        <summary>debug</summary>
        <p>{`turnId=${debug.turnId} sessionId=${debug.sessionId ?? "-"}`}</p>
        <ol>
          {debug.lastEvents.map((event, index) => (
            <li key={`${index}-${event}`}>{event}</li>
          ))}
        </ol>
      </details>
    </main>
  );
}
