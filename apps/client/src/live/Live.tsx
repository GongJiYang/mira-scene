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
import { danmakuReducer, initialDanmakuState, MAX_MOBILE_DANMAKU, visibleDanmaku, danmakuOpacity, type Danmaku } from "./danmaku";
import { cycleChannel, pickLayout, swipeDecision, type LiveLayout } from "./layout";
import { StageRenderer } from "./StageRenderer";
import { LiveEntries, MobileMenu } from "./entries";
import { ActionPanelDesktop } from "./ActionPanel";
import { UI_TEXT } from "./uiText";
import { hudEnabled, useHudStore } from "../obs/hud";
import { OBS_TEXT } from "../obs/obsText";
import { useSceneStatusStore } from "./scene/status";
import { drainRestoredUserLines, useSessionRestoreStore } from "./sessionRestore";
import { progressDots } from "./storyProgress";
import { useGuideScheduler, useInteractionCooldowns, resolveTap } from "./interactionHooks";
import { isStageTapTarget, resolveStageTap } from "./interaction";
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

/**
 * S6l §2：直播间顶部剧情阶段——`streamTitle` + 4 个进度点（当前节点高亮）。
 * 只认服务端下发的当前节点；节点切换时 0.3s 淡入。
 */
function StoryHeader({ characterId, node }: { characterId: string; node: string }) {
  const character = characterOrDefault(characterId);
  const title = character.streamTitles[node as keyof typeof character.streamTitles] ?? "";
  const dots = progressDots(node as never);
  return (
    <div className="live-story-header" data-testid="story-header" data-node={node} key={node}>
      <span className="live-story-title" data-testid="story-title">
        {title}
      </span>
      <span className="live-story-dots" data-testid="story-dots" aria-label={title}>
        {dots.map((state, index) => (
          <i key={index} className="live-story-dot" data-state={state} />
        ))}
      </span>
    </div>
  );
}

/**
 * S6l §3：一条弹幕。观众引导弹幕带随机昵称、可点（hover / 按下态 + 小提示「点一下替你说」）；
 * 用户弹幕与语音转写沿用原样式。
 */
function DanmakuItem({ item, onGuideClick, style }: { item: Danmaku; onGuideClick?: (text: string) => void; style?: React.CSSProperties }) {
  if (item.kind === "guide") {
    return (
      <button
        type="button"
        className="live-danmaku live-danmaku-guide"
        data-kind="guide"
        data-testid="guide-danmaku"
        data-no-stage-tap
        style={style}
        title={UI_TEXT.guideHint}
        onClick={() => onGuideClick?.(item.text)}
      >
        <span className="live-danmaku-nick">{item.nickname ?? UI_TEXT.viewerFallback}:</span>
        <span className="live-danmaku-text">{item.text}</span>
        <span className="live-danmaku-hint">{UI_TEXT.guideHint}</span>
      </button>
    );
  }
  return (
    <p className="live-danmaku" data-kind={item.kind} style={style}>
      {item.text}
    </p>
  );
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
  // S6l-fix1 §2：刷新恢复的背景直接显示（不播交叉淡入）。
  const backgroundDirect = useSceneStatusStore((state) => state.direct);
  const defaultBackground =
    orientation === "portrait" ? "/characters/yuna/bg-mobile.jpg" : "/characters/yuna/bg-desktop.jpg";
  const background = sceneBackground !== null
    ? (orientation === "portrait" ? sceneBackground.mobile : sceneBackground.desktop)
    : defaultBackground;

  // S6l-fix1 §2：刷新恢复——把服务端下发的用户历史弹幕排空进弹幕列表（不重复添加）。
  const restoreLines = useSessionRestoreStore((state) => state.userLines);
  useEffect(() => {
    if (restoreLines.length === 0) return;
    const lines = drainRestoredUserLines();
    if (lines.length > 0) dispatchDanmaku({ type: "RESTORE_USER", texts: lines });
  }, [restoreLines]);

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

  // ---- S6l §3：观众引导弹幕 ----
  // 本节点已用过的引导（点过 / 出现过）；切节点清空（旧节点引导失效）。
  const usedGuidesRef = useRef<Set<string>>(new Set());
  // 当前显示的引导（从弹幕里 kind === "guide" 派生）。
  const visibleGuides = danmaku.items.filter((item) => item.kind === "guide").map((item) => item.text);

  // 切节点：清空已用集合 + 移除旧节点的引导弹幕（§3 切节点后旧节点引导失效）。
  const lastNodeRef = useRef(vm.node);
  useEffect(() => {
    if (lastNodeRef.current === vm.node) return;
    lastNodeRef.current = vm.node;
    usedGuidesRef.current = new Set();
    dispatchDanmaku({ type: "PRUNE_GUIDES" });
  }, [vm.node]);

  // 发送一条引导（点击 = 当作用户文字输入发送）。
  const sendGuide = useCallback(
    (text: string) => {
      usedGuidesRef.current.add(text);
      dispatchDanmaku({ type: "APPEND", kind: "user", text });
      vm.intents.submitText(text);
    },
    [vm.intents],
  );

  useGuideScheduler({
    node: vm.node,
    phase: vm.phase,
    characterId: vm.characterId,
    dispatchDanmaku,
    visibleGuides,
    usedGuides: () => [...usedGuidesRef.current],
    markUsed: (guide) => usedGuidesRef.current.add(guide),
    submitText: sendGuide,
    poke: () => {},
    gift: () => {},
    tapInterrupt: () => {},
  });

  // ---- S6l §5：戳一下 / 送礼物（冷却） ----
  const cooldowns = useInteractionCooldowns({
    poke: () => vm.intents.poke(),
    gift: () => vm.intents.gift(),
  });

  // ---- S6l §6：点击画面（S6l-fix2 §1：只有落在舞台空白处才算） ----
  const onStageTap = useCallback(
    (hitCharacter: boolean, target?: unknown) => {
      const intent = target === undefined ? resolveTap(vm.phase, hitCharacter) : resolveStageTap(vm.phase, target, hitCharacter);
      if (intent === "interrupt") vm.intents.tapInterrupt();
      else if (intent === "poke") cooldowns.poke();
    },
    [vm.phase, vm.intents, cooldowns],
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
      animateBackground={!backgroundDirect}
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
              <StageTapLayer onTap={onStageTap} />
              {/* S6l §2：顶部剧情阶段（标题 + 进度点）。 */}
              <StoryHeader characterId={character.id} node={vm.node} />
              {stage}
              {/* S6c §5：换背景转场状态条（右上角） */}
              <SceneStatusBar />
              <div className="live-hud" data-no-stage-tap>
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
            <p className="live-subtitle" data-testid="subtitle" data-no-stage-tap>
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
            {/* S6m §3：桌面在弹幕窗口顶部做一个可展开的「动作表」标签（默认收起）。 */}
            <ActionPanelDesktop phase={vm.phase} />
            <h2 className="live-chat-title">{UI_TEXT.chat}</h2>
            <div className="live-chat-list" data-testid="danmaku-list">
              {danmaku.items.map((item) => (
                <DanmakuItem key={item.id} item={item} onGuideClick={sendGuide} />
              ))}
            </div>
            <form
              className="live-compose"
              data-no-stage-tap
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
                data-testid="gift"
                aria-label={UI_TEXT.gift}
                title={UI_TEXT.gift}
                onClick={cooldowns.gift}
              >
                🎁
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
      onStageTap={onStageTap}
      onGuideClick={sendGuide}
      onGift={cooldowns.gift}
    />
  );
}

/**
 * S6l §6：画面点击层。覆盖整个舞台，透明；点击时判定是否命中角色（用包围盒近似）。
 * 在说话时点任何位置都打断；空闲时点到角色才戳一下。
 */
function StageTapLayer({ onTap, bboxSelector }: { onTap: (hitCharacter: boolean) => void; bboxSelector?: string }) {
  const handle = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // S6l-fix2 §1：防御——点击落在交互元素内时忽略（桌面上点击层通常不与它们重叠）。
      if (isStageTapTarget(event.target)) return;
      const target = event.currentTarget.parentElement;
      let hitCharacter = true;
      // 命中判定：角色画布占舞台中间竖条；用画布矩形近似包围盒（存在透明边，但够用）。
      const selector = bboxSelector ?? '[data-testid="yuna-canvas"]';
      const canvas = (target ?? event.currentTarget).querySelector(selector) as HTMLElement | null;
      const root = target ?? event.currentTarget;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        // 角色实际占据画布中间约 60% 宽（模型两侧留白），高度全高。
        const left = rect.left + rootRect.left * 0 + rect.width * 0.2;
        const right = rect.left + rect.width * 0.8;
        const x = event.clientX;
        const y = event.clientY;
        hitCharacter = x >= left && x <= right && y >= rect.top && y <= rect.bottom;
      }
      onTap(hitCharacter);
    },
    [onTap, bboxSelector],
  );
  return <div className="live-stage-tap" data-testid="stage-tap" onClick={handle} aria-hidden />;
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
  onStageTap: (hitCharacter: boolean, target?: unknown) => void;
  onGuideClick: (text: string) => void;
  onGift: () => void;
};

/** 手机布局：竖屏全屏 + 左下浮层弹幕 + 底部胶囊输入 + 上下滑切主播。 */
function MobileLive(props: MobileProps) {
  const { vm, characterId, subtitle, danmaku, draft, setDraft, submit, startPtt, endPtt, switchTo, stage, listening, level, onStageTap, onGuideClick, onGift } = props;
  const character = characterOrDefault(characterId);
  const [slide, setSlide] = useState(0);
  const touch = useRef<{ y: number; t: number } | null>(null);
  // S6l §5/§6：滑动切频道与点击打架——短按（无明显位移）才当作点击交给 tap 层。
  const tap = useRef<{ x: number; y: number; t: number } | null>(null);

  const onTouchStart = (event: React.TouchEvent): void => {
    const point = event.touches[0];
    if (!point) return;
    touch.current = { y: point.clientY, t: performance.now() };
    tap.current = { x: point.clientX, y: point.clientY, t: performance.now() };
  };

  const onTouchEnd = (event: React.TouchEvent): void => {
    const start = touch.current;
    touch.current = null;
    const point = event.changedTouches[0];
    const startTap = tap.current;
    tap.current = null;
    if (!start || !point) return;
    const dy = point.clientY - start.y;
    const dt = Math.max(1, performance.now() - start.t);
    const direction = swipeDecision(dy, dy / dt);
    if (direction !== null) {
      const next = cycleChannel(VISIBLE_CHARACTERS.map((item) => item.id), characterId, direction);
      // 整屏滑动过渡：先滑出，再切换，再滑回。
      setSlide(direction === "next" ? -1 : 1);
      window.setTimeout(() => {
        switchTo(next);
        setSlide(0);
      }, 180);
      return;
    }
    // S6l §5/§6：短按（无明显位移、<300ms）→ 当点击处理。
    if (startTap) {
      const moved = Math.abs(point.clientX - startTap.x) + Math.abs(point.clientY - startTap.y);
      if (moved < 12 && performance.now() - startTap.t < 300) {
        // S6l-fix2 §1：由 resolveStageTap 统一判定——落在交互元素内（输入框 / 引导弹幕 / 字幕 / 菜单 / 卡片按钮）忽略。
        onStageTap(hitCharacterAt(point.clientX, point.clientY), event.target);
      }
    }
  };

  const visible = visibleDanmaku(danmaku, MAX_MOBILE_DANMAKU);

  // S6l §5：手机端命中判定——角色画布中间竖条（近似包围盒）。
  // S6l-fix2 §1：画布找不到时返回 false（不再当作命中角色，避免误触 poke）。
  const hitCharacterAt = (x: number, y: number): boolean => {
    const canvas = document.querySelector('[data-testid="yuna-canvas"]') as HTMLElement | null;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    return x >= rect.left + rect.width * 0.2 && x <= rect.left + rect.width * 0.8 && y >= rect.top && y <= rect.bottom;
  };

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
          {/* S6l §2：顶部剧情阶段（标题 + 进度点）。 */}
          <StoryHeader characterId={characterId} node={vm.node} />
          {stage}
          {/* S6c §5：换背景转场状态条（右上角，手机同样显示）。 */}
          <SceneStatusBar />
        </div>

        <div className="live-mobile-top" data-no-stage-tap>
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
          {/* S6g-A §5：手机端可展开菜单（文档 / 观测入口 + S6m §3 动作表）。 */}
          <MobileMenu phase={vm.phase} />
        </div>

        <div className="live-mobile-danmaku" data-testid="danmaku-list" data-no-stage-tap>
          {visible.map((item, index) => (
            <DanmakuItem key={item.id} item={item} onGuideClick={onGuideClick} style={{ opacity: danmakuOpacity(index, visible.length) }} />
          ))}
        </div>

        <p className="live-mobile-subtitle" data-testid="subtitle" data-no-stage-tap>
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
          data-no-stage-tap
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
            data-testid="gift"
            aria-label={UI_TEXT.gift}
            title={UI_TEXT.gift}
            onClick={onGift}
          >
            🎁
          </button>
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
