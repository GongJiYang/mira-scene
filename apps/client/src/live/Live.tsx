/**
 * 直播间 UI v1（S6b §4）。
 *
 * 约束（D14）：**只读** `useStageViewModel()`；不直接 import store / connection / audio。
 * 布局：宽 ≥ 900px 桌面（仿 Twitch），否则手机（仿 TikTok / Instagram 直播）。
 * 风格参考《主播女孩重度依赖》：粉紫配色、像素字体点缀、老式系统窗口边框（只借风格）。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useStageViewModel } from "../view/useStageViewModel";
import { micInputLevel } from "../core/controller";
import { characterOrDefault, VISIBLE_CHARACTERS } from "./characters";
import { danmakuReducer, initialDanmakuState, MAX_MOBILE_DANMAKU, visibleDanmaku, danmakuOpacity } from "./danmaku";
import { cycleChannel, pickLayout, swipeDecision, type LiveLayout } from "./layout";
import { StageRenderer } from "./StageRenderer";
import { LiveEntries, MobileMenu } from "./entries";
import { UI_TEXT } from "./uiText";
import { hudEnabled, useHudStore } from "../obs/hud";
import { OBS_TEXT } from "../obs/obsText";
import { useSceneStatusStore } from "./scene/status";
import "./live.css";
import "../obs/obs.css";

/** S6h §3：?hud=1 时显示上一轮「首包 xxx ms」角标（数据来自客户端自测，不依赖服务端）。 */
function FirstAudioHud() {
  const ms = useHudStore((s) => s.firstAudioMs);
  if (!hudEnabled() || ms === undefined) return null;
  return (
    <span className="live-hud-first-audio" data-testid="hud-first-audio">
      {OBS_TEXT.firstAudioHud(ms)}
    </span>
  );
}

/** 监听窗口宽度 → 布局。 */
function useLayout(): LiveLayout {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return pickLayout(width);
}

export function Live() {
  const vm = useStageViewModel();
  const layout = useLayout();
  const character = characterOrDefault(vm.characterId);

  const [danmaku, dispatchDanmaku] = useReducer(danmakuReducer, initialDanmakuState);
  const [draft, setDraft] = useState("");
  const holding = useRef(false);

  const orientation = layout === "desktop" ? "landscape" : "portrait";
  // S6c §5：换背景 ready 后换成新背景；否则用角色包默认背景（D43：只有忧奈）。
  const sceneBackground = useSceneStatusStore((state) => state.backgroundUrl);
  const defaultBackground =
    orientation === "portrait" ? "/characters/yuna/bg-mobile.jpg" : "/characters/yuna/bg-desktop.jpg";
  const background = sceneBackground !== null
    ? (orientation === "portrait" ? sceneBackground.mobile : sceneBackground.desktop)
    : defaultBackground;

  // 用户自己发的文字进弹幕；语音转写同理（transcript 走 subtitle 之外的独立通道，这里用 subtitle 兜底）。
  const submit = useCallback(() => {
    const text = draft.trim();
    if (text === "") return;
    dispatchDanmaku({ type: "APPEND", kind: "user", text });
    vm.intents.submitText(text);
    setDraft("");
  }, [draft, vm.intents]);

  // PTT：按下即打断（D34 由 controller 保证）。
  const startPtt = useCallback(() => {
    if (holding.current) return;
    holding.current = true;
    vm.intents.pttDown();
  }, [vm.intents]);

  const endPtt = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    vm.intents.pttUp();
  }, [vm.intents]);

  useEffect(() => {
    window.addEventListener("pointerup", endPtt);
    window.addEventListener("pointercancel", endPtt);
    return () => {
      window.removeEventListener("pointerup", endPtt);
      window.removeEventListener("pointercancel", endPtt);
    };
  }, [endPtt]);

  const switchTo = useCallback(
    (characterId: string) => {
      if (characterId === vm.characterId) return;
      dispatchDanmaku({ type: "CLEAR" });
      vm.intents.switchChannel(characterId);
    },
    [vm.characterId, vm.intents],
  );

  const subtitle = vm.subtitle ?? vm.fallbackSubtitle ?? "";

  // S6f §2：倾听声波随输入音量跳动（rAF 本地读取 recorder 的 RMS）。
  const listening = vm.phase === "listening";
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!listening) {
      setLevel(0);
      return;
    }
    let raf = 0;
    const tick = (): void => {
      setLevel(micInputLevel());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [listening]);

  const stage = (
    <StageRenderer
      characterId={character.id}
      phase={vm.phase}
      visual={vm.visual}
      performance={vm.performance}
      storyMedia={vm.storyMedia}
      orientation={orientation}
      backgroundUrl={background}
      turnId={vm.debug.turnId}
    />
  );

  if (layout === "desktop") {
    return (
      <main className="live-root" data-testid="live" data-layout="desktop" data-phase={vm.phase} data-connection={vm.connection} data-accent={vm.visual.accent ?? ""}>
        <div className="live-desktop">
          <nav className="live-sidebar" aria-label={UI_TEXT.channels}>
            {VISIBLE_CHARACTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="live-channel"
                data-testid={`channel-${item.id}`}
                data-active={item.id === character.id}
                aria-label={item.displayName}
                onClick={() => switchTo(item.id)}
              >
                <img src={item.avatar} alt="" />
              </button>
            ))}
          </nav>

          <section className="live-main">
            <div className="live-stage" data-testid="live-stage">
              {stage}
              {/* S6c §5：换背景转场状态条（右上角） */}
              <SceneStatusBar />
              <div className="live-hud">
                <span className="live-badge">{UI_TEXT.live}</span>
                <span className="live-hud-name" data-testid="live-name">
                  {character.displayName}
                </span>
                <span className="live-hud-viewers">{UI_TEXT.viewers}</span>
                <FirstAudioHud />
                {/* S6g-A §5：桌面顶栏右侧的「文档」「观测」入口。 */}
                <LiveEntries />
              </div>
              {vm.error && vm.debugMode && (
                <p className="live-error">{`${vm.error.code}: ${vm.error.message}`}</p>
              )}
            </div>
            <p className="live-subtitle" data-testid="subtitle">
              {subtitle}
              {/* S6f §2：思考时字幕区出现「……」三点动画（不是聊天气泡，不改字幕区结构）。 */}
              {vm.phase === "thinking" && (
                <span className="live-thinking-dots" data-testid="thinking-dots" aria-hidden>
                  <i>.</i>
                  <i>.</i>
                  <i>.</i>
                </span>
              )}
            </p>
          </section>

          <aside className="live-chat">
            <h2 className="live-chat-title">{UI_TEXT.chat}</h2>
            <div className="live-chat-list" data-testid="danmaku-list">
              {danmaku.items.map((item) => (
                <p key={item.id} className="live-danmaku" data-kind={item.kind}>
                  {item.text}
                </p>
              ))}
            </div>
            <form
              className="live-compose"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <input
                className="live-input"
                data-testid="text-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={UI_TEXT.inputPlaceholder}
                aria-label={UI_TEXT.inputPlaceholder}
              />
              <button type="submit" className="live-button">
                {UI_TEXT.send}
              </button>
              <button
                type="button"
                className="live-button"
                data-testid="ptt"
                data-active={vm.phase === "listening"}
                aria-label={UI_TEXT.mic}
                onPointerDown={startPtt}
                onPointerUp={endPtt}
                onPointerLeave={endPtt}
                onPointerCancel={endPtt}
              >
                ●
              </button>
              {/* S6f §2：倾听声波（随输入音量跳动）；文字输入时也显示「正在听」。 */}
              {listening && (
                <span className="live-wave" data-testid="listening-wave" style={{ ["--level" as never]: level }} aria-hidden>
                  <i />
                  <i />
                  <i />
                  <span className="live-wave-label">{UI_TEXT.listening}</span>
                </span>
              )}
            </form>
          </aside>
        </div>
      </main>
    );
  }

  return (
    <MobileLive
      vm={vm}
      characterId={character.id}
      subtitle={subtitle}
      danmaku={danmaku.items}
      draft={draft}
      setDraft={setDraft}
      submit={submit}
      startPtt={startPtt}
      endPtt={endPtt}
      switchTo={switchTo}
      stage={stage}
      listening={listening}
      level={level}
    />
  );
}

/** S6c §5：换背景转场状态条（右上角）。 */
function SceneStatusBar() {
  const display = useSceneStatusStore((state) => state.display);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (display.kind === "idle") {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (display.kind === "ready" || display.kind === "failed" || display.kind === "rejected" || display.kind === "busy") {
      const timer = window.setTimeout(() => setVisible(false), 3_000);
      return () => window.clearTimeout(timer);
    }
  }, [display.kind]);

  if (!visible) return null;

  const text =
    display.kind === "writing" || display.kind === "generating"
      ? UI_TEXT.sceneTransition
      : display.kind === "ready"
        ? `${UI_TEXT.sceneReady}${display.label !== "" ? `：${display.label}` : ""}`
        : UI_TEXT.sceneFailed;

  return (
    <div className="live-scene-status" data-testid="scene-status" data-kind={display.kind}>
      {text}
    </div>
  );
}

type MobileProps = {
  vm: ReturnType<typeof useStageViewModel>;
  characterId: string;
  subtitle: string;
  danmaku: ReturnType<typeof danmakuReducer>["items"];
  draft: string;
  setDraft: (value: string) => void;
  submit: () => void;
  startPtt: () => void;
  endPtt: () => void;
  switchTo: (characterId: string) => void;
  stage: React.ReactNode;
  listening: boolean;
  level: number;
};

/** 手机布局：竖屏全屏 + 左下浮层弹幕 + 底部胶囊输入 + 上下滑切主播。 */
function MobileLive(props: MobileProps) {
  const { vm, characterId, subtitle, danmaku, draft, setDraft, submit, startPtt, endPtt, switchTo, stage, listening, level } = props;
  const character = characterOrDefault(characterId);
  const [slide, setSlide] = useState(0);
  const touch = useRef<{ y: number; t: number } | null>(null);

  const onTouchStart = (event: React.TouchEvent): void => {
    const point = event.touches[0];
    if (!point) return;
    touch.current = { y: point.clientY, t: performance.now() };
  };

  const onTouchEnd = (event: React.TouchEvent): void => {
    const start = touch.current;
    touch.current = null;
    const point = event.changedTouches[0];
    if (!start || !point) return;
    const dy = point.clientY - start.y;
    const dt = Math.max(1, performance.now() - start.t);
    const direction = swipeDecision(dy, dy / dt);
    if (direction === null) return;
    const next = cycleChannel(VISIBLE_CHARACTERS.map((item) => item.id), characterId, direction);
    // 整屏滑动过渡：先滑出，再切换，再滑回。
    setSlide(direction === "next" ? -1 : 1);
    window.setTimeout(() => {
      switchTo(next);
      setSlide(0);
    }, 180);
  };

  const visible = visibleDanmaku(danmaku, MAX_MOBILE_DANMAKU);

  return (
    <main
      className="live-root"
      data-testid="live"
      data-layout="mobile"
      data-phase={vm.phase}
      data-connection={vm.connection}
      data-accent={vm.visual.accent ?? ""}
    >
      <div
        className="live-mobile"
        data-testid="live-mobile"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div
          className="live-mobile-stage"
          data-testid="live-stage"
          style={{ transform: `translateY(${slide * 100}%)` }}
        >
          {stage}
          {/* S6c §5：换背景转场状态条（右上角，手机同样显示）。 */}
          <SceneStatusBar />
        </div>

        <div className="live-mobile-top">
          <div className="live-mobile-avatar">
            <img src={character.avatar} alt="" />
          </div>
          <span className="live-mobile-name" data-testid="live-name">
            {character.displayName}
          </span>
          <span className="live-badge">{UI_TEXT.live}</span>
          <span className="live-mobile-spacer" />
          <button
            type="button"
            className="live-mobile-mic"
            data-testid="switch-channel"
            aria-label={UI_TEXT.switchChannel}
            onClick={() => {
              const next = cycleChannel(VISIBLE_CHARACTERS.map((item) => item.id), characterId, "next");
              switchTo(next);
            }}
          >
            ⇅
          </button>
          {/* S6g-A §5：手机端可展开菜单（文档 / 观测入口）。 */}
          <MobileMenu />
        </div>

        <div className="live-mobile-danmaku" data-testid="danmaku-list">
          {visible.map((item, index) => (
            <p
              key={item.id}
              className="live-danmaku"
              data-kind={item.kind}
              style={{ opacity: danmakuOpacity(index, visible.length) }}
            >
              {item.text}
            </p>
          ))}
        </div>

        <p className="live-mobile-subtitle" data-testid="subtitle">
          {subtitle}
          {vm.phase === "thinking" && (
            <span className="live-thinking-dots" data-testid="thinking-dots" aria-hidden>
              <i>.</i>
              <i>.</i>
              <i>.</i>
            </span>
          )}
        </p>

        <form
          className="live-mobile-compose"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            className="live-mobile-input"
            data-testid="text-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={UI_TEXT.inputPlaceholder}
            aria-label={UI_TEXT.inputPlaceholder}
          />
          <button
            type="button"
            className="live-mobile-mic"
            data-testid="ptt"
            data-active={vm.phase === "listening"}
            aria-label={UI_TEXT.mic}
            onPointerDown={startPtt}
            onPointerUp={endPtt}
            onPointerLeave={endPtt}
            onPointerCancel={endPtt}
          >
            ●
          </button>
          {/* S6f §2：倾听声波（随输入音量跳动）；文字输入时也显示「正在听」。 */}
          {listening && (
            <span className="live-wave" data-testid="listening-wave" style={{ ["--level" as never]: level }} aria-hidden>
              <i />
              <i />
              <i />
              <span className="live-wave-label">{UI_TEXT.listening}</span>
            </span>
          )}
        </form>

        {vm.error && vm.debugMode && <p className="live-error">{`${vm.error.code}: ${vm.error.message}`}</p>}
        <span className="live-status" data-testid="status">
          {vm.connection === "open" ? "" : UI_TEXT.connecting}
        </span>
      </div>
    </main>
  );
}
