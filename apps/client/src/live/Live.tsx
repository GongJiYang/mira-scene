/**
 * 直播间 UI v2（S6u「深夜推流」）。
 *
 * 约束（D14）：**只读** `useStageViewModel()`；不直接 import store / connection / audio。
 * 布局：宽 ≥ 900px 桌面（舞台窗口 + 输入条 / 右侧弹幕窗口），否则手机（竖屏全屏）。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useStageViewModel } from "../view/useStageViewModel";
import { micInputLevel } from "../core/controller";
import { characterOrDefault, VISIBLE_CHARACTERS } from "./characters";
import { danmakuReducer, initialDanmakuState, MAX_MOBILE_DANMAKU, visibleDanmaku, danmakuOpacity, type Danmaku } from "./danmaku";
import { pickLayout, type LiveLayout } from "./layout";
import { StageRenderer } from "./StageRenderer";
import { LiveEntries, MobileMenu } from "./entries";
import { ActionPanelDesktop } from "./ActionPanel";
import { ModeBadge, SettingsDialogDesktop } from "./SettingsPanel";
import { formatHms, UI_TEXT } from "./uiText";
import { stateChipFor } from "./stateChip";
import { hudEnabled, useHudStore } from "../obs/hud";
import { OBS_TEXT } from "../obs/obsText";
import { useSceneStatusStore } from "./scene/status";
import { useConnectionStore } from "../core/store";
import { drainRestoredUserLines, useSessionRestoreStore } from "./sessionRestore";
import { drainTranscripts, useTranscriptStore } from "./transcriptStore";
import { progressDots } from "./storyProgress";
import { useGuideScheduler, useInteractionCooldowns, resolveTap } from "./interactionHooks";
import { isStageTapTarget, resolveStageTap } from "./interaction";
import type { StagePhase } from "../view/useStageViewModel";
import "./live.css";
import "../obs/obs.css";

/**
 * §5.1：顶栏真实开播时长（`HH:MM:SS`，每秒刷新）。
 * 起点是服务端下发的会话创建时刻 `startedAt`；恢复会话时沿用原值（从会话开始继续）。
 * 尚未收到 startedAt 时显示 `00:00:00`（短暂）。
 */
function LiveDuration() {
  const startedAt = useConnectionStore((s) => s.startedAt);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = startedAt === null ? 0 : Date.now() - startedAt;
  return (
    <span className="live-stage-meta" data-testid="live-duration">
      {`${UI_TEXT.viewerCount} · ${formatHms(elapsed)}`}
    </span>
  );
}

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
 * S6l §2 / S6u §2：剧情阶段——`streamTitle` + 4 个进度点（当前节点高亮）。
 * 只认服务端下发的当前节点；节点切换时 0.3s 淡入。S6u：移入舞台标题栏。
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
 * S6u §2/§3：舞台右上角状态牌（读 phase）。映射逻辑在纯函数 `stateChipFor`。
 * 四态：待机灰点 / 倾听蓝耳朵 / 思考琥珀三点 / 说话淡紫声波柱。
 */
function StateChip({ phase }: { phase: StagePhase }) {
  const { tone, label } = stateChipFor(phase);
  return (
    <div className="live-state-chip" data-testid="state-chip" data-tone={tone} aria-live="polite">
      {tone === "idle" && <span className="live-state-dot" aria-hidden />}
      {tone === "listen" && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <path d="M6 14a6 6 0 1 1 12 0c0 3-3 3-3 6a3 3 0 0 1-6 0" />
        </svg>
      )}
      {tone === "think" && (
        <span className="live-state-think" aria-hidden>
          ···
        </span>
      )}
      {tone === "speak" && (
        <span className="live-state-wave" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
      <span className="live-state-label">{label}</span>
      {tone === "speak" && <span className="live-state-en">{UI_TEXT.stateSpeakingEn}</span>}
    </div>
  );
}

/**
 * S6l §3 / S6u §2：一条弹幕。
 * 观众引导弹幕（guide）：彩色昵称 + 虚线淡紫框 + 「↳ 点一下替你说」，可点。
 * 用户弹幕（user）：淡紫粗体昵称「你」。语音转写（transcript）：暗色。
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
        <span className="live-danmaku-nick">{item.nickname ?? UI_TEXT.viewerFallback}</span>
        <span className="live-danmaku-text">{item.text}</span>
        <span className="live-danmaku-hint">{`${UI_TEXT.guidePrefix}${UI_TEXT.guideHint}`}</span>
      </button>
    );
  }
  if (item.kind === "transcript") {
    return (
      <p className="live-danmaku" data-kind="transcript" style={style}>
        <span className="live-danmaku-nick live-danmaku-nick-user">{UI_TEXT.youVoice}</span>
        <span className="live-danmaku-text">{item.text}</span>
      </p>
    );
  }
  return (
    <p className="live-danmaku" data-kind={item.kind} style={style}>
      <span className="live-danmaku-nick live-danmaku-nick-user">{UI_TEXT.you}</span>
      <span className="live-danmaku-text">{item.text}</span>
    </p>
  );
}

/**
 * S6u §2：字幕对话框（底部居中，宽 ≤ 680）。
 * 「忧奈」名牌 + 正文；兜底台词（fallbackSubtitle）用琥珀名牌「忧奈 · 网络卡了」。
 * 逐字进度：现状没有该状态，整句亮显示（不为视觉改字幕逻辑）。
 * 说话时下方显示一行小字「点画面任意位置可以打断她」。
 */
function SubtitleBox({ subtitle, fallback, thinking, speaking, ttsDegraded }: { subtitle: string; fallback: boolean; thinking: boolean; speaking: boolean; ttsDegraded: boolean }) {
  if (subtitle === "" && !thinking) return null;
  return (
    <div className="live-subtitle-box" data-no-stage-tap>
      <div className="live-subtitle-name" data-fallback={fallback ? "1" : "0"}>
        {fallback ? UI_TEXT.fallbackSpeaker : UI_TEXT.speakerName}
      </div>
      <p className="live-subtitle" data-testid="subtitle" data-fallback={fallback ? "1" : "0"}>
        {subtitle}
        {/* S6f §2：思考时字幕区出现「……」三点动画（不是聊天气泡，不改字幕区结构）。 */}
        {thinking && (
          <span className="live-thinking-dots" data-testid="thinking-dots" aria-hidden>
            <i>.</i>
            <i>.</i>
            <i>.</i>
          </span>
        )}
      </p>
      {/* S6u §2：说话时字幕下方小字提示。 */}
      {speaking && (
        <div className="live-interrupt-hint" data-testid="interrupt-hint">
          {UI_TEXT.interruptHint}
        </div>
      )}
      {/* freeze-fix5 §2.2：本轮 TTS 降级 → 字幕区附近的一行轻提示（琥珀色，复用兜底字幕色调）。 */}
      {ttsDegraded && (
        <div className="live-tts-degraded-hint" data-testid="tts-degraded-hint">
          {UI_TEXT.ttsDegradedHint}
        </div>
      )}
    </div>
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

  // freeze-fix9 §3：语音识别结果（当前轮）进弹幕区，像用户弹幕一样显示；旧轮的丢弃（D3）。
  const pendingTranscripts = useTranscriptStore((state) => state.pending);
  useEffect(() => {
    if (pendingTranscripts.length === 0) return;
    const lines = drainTranscripts(vm.debug.turnId);
    for (const text of lines) dispatchDanmaku({ type: "APPEND", kind: "transcript", text });
  }, [pendingTranscripts, vm.debug.turnId]);

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

  /**
   * freeze-fix4 §2：按下即捕获指针（setPointerCapture）。
   * 否则按下后布局位移（「正在听」/声波）会让指针落到按钮外触发 pointerleave，
   * 导致录音瞬间被 pttUp 结束。捕获后 pointerup / pointercancel 仍会命中本元素。
   */
  const onPttDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // 合成事件（pointerId 缺失）无法捕获；结束仍靠 pointerup / pointercancel。
      }
      startPtt();
    },
    [startPtt],
  );

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
          {/* 舞台窗口：40px 标题栏（主播信息 + 剧情进度 + 入口） + 舞台体 */}
          <section className="live-stage-window" aria-label="直播画面">
            <div className="live-stage-bar" data-testid="stage-bar" data-no-stage-tap>
              {/* D43：频道栏只留忧奈；按钮从旧左侧栏迁到标题栏头像位（保 testid）。 */}
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
              <span className="live-stage-name" data-testid="live-name">
                {character.displayName}
              </span>
              <span className="live-badge">{UI_TEXT.live}</span>
              {/* §5.1：真实开播时长（每秒刷新），替换原写死的 02:14:37。 */}
              <LiveDuration />
              <span className="live-stage-spacer" />
              {/* S6l §2：剧情标题 + 进度点（移入标题栏）。 */}
              <StoryHeader characterId={character.id} node={vm.node} />
              <span className="live-stage-divider" />
              {/* S6g-A §5：桌面顶栏右侧的「文档」「观测」入口。 */}
              <LiveEntries />
              {/* D49 / S6n §5：桌面顶栏「设置」入口（对话框）。 */}
              <SettingsDialogDesktop vm={vm} />
              {/* D49 / S6n §5：顶栏模式小标签（Mock / 真实）。 */}
              <ModeBadge vm={vm} />
              <FirstAudioHud />
            </div>

            <div className="live-stage" data-testid="live-stage">
              <StageTapLayer onTap={onStageTap} />
              {stage}
              {/* S6c §5：换背景转场状态条（右上角） */}
              <SceneStatusBar />
              {/* S6u §2：状态牌（读 phase）。 */}
              <StateChip phase={vm.phase} />
              {vm.error && vm.debugMode && (
                <p className="live-error">{`${vm.error.code}: ${vm.error.message}`}</p>
              )}
              {/* S6u §2：字幕对话框（底部居中）。 */}
              <SubtitleBox subtitle={subtitle} fallback={vm.subtitle === null && vm.fallbackSubtitle !== null} thinking={vm.phase === "thinking"} speaking={vm.phase === "speaking"} ttsDegraded={vm.ttsDegraded} />
            </div>
          </section>

          {/* 输入条 */}
          <form
            className="live-input-bar"
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
            <button
              type="button"
              className="live-gift"
              data-testid="gift"
              aria-label={UI_TEXT.gift}
              title={UI_TEXT.gift}
              onClick={cooldowns.gift}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="8" width="18" height="13" rx="2" />
                <path d="M12 8v13M3 12h18M12 8c-1.5-3-5-3.5-5-1.2C7 8 9.5 8 12 8zM12 8c1.5-3 5-3.5 5-1.2C17 8 14.5 8 12 8z" />
              </svg>
            </button>
            <button type="submit" className="live-send">
              {UI_TEXT.send}
            </button>
            <button
              type="button"
              className="live-ptt-pill"
              data-testid="ptt"
              data-active={vm.phase === "listening"}
              aria-label={UI_TEXT.mic}
              onPointerDown={onPttDown}
              onPointerUp={endPtt}
              onPointerCancel={endPtt}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
              {UI_TEXT.mic}
            </button>
            {/*
             * S6f §2：倾听声波（随输入音量跳动）；文字输入时也显示「正在听」。
             * freeze-fix4 §2：外层固定宽度槽位——声波出现 / 消失都不得挤动 PTT 按钮。
             */}
            <span className="live-wave-slot">
              {listening && (
                <span className="live-wave" data-testid="listening-wave" style={{ ["--level" as never]: level }} aria-hidden>
                  <i />
                  <i />
                  <i />
                  <span className="live-wave-label">{UI_TEXT.listening}</span>
                </span>
              )}
            </span>
          </form>

          {/* 弹幕窗口（占两行） */}
          <aside className="live-chat">
            <div className="live-chat-bar">
              <span className="live-chat-bar-title">{UI_TEXT.chat}</span>
              <span className="live-chat-bar-meta">{UI_TEXT.chatOnline(danmaku.items.length)}</span>
            </div>
            {/* S6m §3：桌面在弹幕窗口顶部做一个可展开的「动作表」标签（默认收起）。 */}
            <ActionPanelDesktop phase={vm.phase} />
            <div className="live-chat-list" data-testid="danmaku-list">
              {danmaku.items.map((item) => (
                <DanmakuItem key={item.id} item={item} onGuideClick={sendGuide} />
              ))}
            </div>
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
      onPttDown={onPttDown}
      endPtt={endPtt}
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
  onPttDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  endPtt: () => void;
  stage: React.ReactNode;
  listening: boolean;
  level: number;
  onStageTap: (hitCharacter: boolean, target?: unknown) => void;
  onGuideClick: (text: string) => void;
  onGift: () => void;
};

/** 手机布局：竖屏全屏 + 左下浮层弹幕 + 底部胶囊输入。 */
function MobileLive(props: MobileProps) {
  const { vm, characterId, subtitle, danmaku, draft, setDraft, submit, onPttDown, endPtt, stage, listening, level, onStageTap, onGuideClick, onGift } = props;
  const character = characterOrDefault(characterId);
  // S6l §5/§6：短按（无明显位移）才当作点击交给 tap 层。
  const tap = useRef<{ x: number; y: number; t: number } | null>(null);

  // S6u §3：录音面板计时（连续 0 起的本地计时，VT323 显示 mm:ss）。无上滑取消功能。
  const [recordMs, setRecordMs] = useState(0);
  const recordStartRef = useRef(0);
  useEffect(() => {
    if (!listening) {
      setRecordMs(0);
      return;
    }
    recordStartRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
    setRecordMs(0);
    const timer = window.setInterval(() => {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      setRecordMs(now - recordStartRef.current);
    }, 250);
    return () => window.clearInterval(timer);
  }, [listening]);

  const onTouchStart = (event: React.TouchEvent): void => {
    const point = event.touches[0];
    if (!point) return;
    tap.current = { x: point.clientX, y: point.clientY, t: performance.now() };
  };

  const onTouchEnd = (event: React.TouchEvent): void => {
    const point = event.changedTouches[0];
    const startTap = tap.current;
    tap.current = null;
    if (!point || !startTap) return;
    // §5.3：删除上下滑切频道手势（D43 只剩忧奈），只保留短按点击。
    const moved = Math.abs(point.clientX - startTap.x) + Math.abs(point.clientY - startTap.y);
    if (moved < 12 && performance.now() - startTap.t < 300) {
      // S6l-fix2 §1：由 resolveStageTap 统一判定——落在交互元素内（输入框 / 引导弹幕 / 字幕 / 菜单 / 卡片按钮）忽略。
      onStageTap(hitCharacterAt(point.clientX, point.clientY), event.target);
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
        <div className="live-mobile-stage" data-testid="live-stage">
          {stage}
          {/* S6c §5：换背景转场状态条（右上角，手机同样显示）。 */}
          <SceneStatusBar />
        </div>

        {/* 顶栏：主播信息胶囊 + 菜单；下方剧情标题胶囊 + 进度点。 */}
        <header className="live-mobile-header" data-no-stage-tap>
          <div className="live-mobile-top">
            <div className="live-mobile-id">
              <div className="live-mobile-avatar">
                <img src={character.avatar} alt="" />
              </div>
              <div className="live-mobile-id-text">
                <span className="live-mobile-name" data-testid="live-name">
                  {character.displayName}
                </span>
                <span className="live-mobile-viewers">{UI_TEXT.viewerCount}</span>
              </div>
              <span className="live-badge">{UI_TEXT.live}</span>
            </div>
            <span className="live-mobile-spacer" />
            {/* D49 / S6n §5：手机顶栏模式小标签。 */}
            <ModeBadge vm={vm} />
            {/* §5.3：D43 只剩忧奈——删除「⇅」切频道按钮（桌面已删频道栏）。 */}
            {/* S6g-A §5：手机端可展开菜单（文档 / 观测入口 + S6m §3 动作表 + 设置）。 */}
            <MobileMenu phase={vm.phase} vm={vm} />
          </div>
          <StoryHeader characterId={characterId} node={vm.node} />
        </header>

        {/* S6u §3：状态牌（顶栏下方右侧）。 */}
        <StateChip phase={vm.phase} />

        <div className="live-mobile-danmaku" data-testid="danmaku-list" data-no-stage-tap>
          {visible.map((item, index) => (
            <DanmakuItem key={item.id} item={item} onGuideClick={onGuideClick} style={{ opacity: danmakuOpacity(index, visible.length) }} />
          ))}
        </div>

        <p className="live-mobile-subtitle" data-testid="subtitle" data-no-stage-tap data-fallback={vm.subtitle === null && vm.fallbackSubtitle !== null ? "1" : "0"}>
          {subtitle}
          {vm.phase === "thinking" && (
            <span className="live-thinking-dots" data-testid="thinking-dots" aria-hidden>
              <i>.</i>
              <i>.</i>
              <i>.</i>
            </span>
          )}
        </p>

        {/* freeze-fix5 §2.2：本轮 TTS 降级 → 字幕附近的一行轻提示。 */}
        {vm.ttsDegraded && (
          <div className="live-tts-degraded-hint live-tts-degraded-hint-mobile" data-testid="tts-degraded-hint" data-no-stage-tap>
            {UI_TEXT.ttsDegradedHint}
          </div>
        )}

        {/* S6u §3：按住说话时底部录音面板（声波随音量、计时、松开发送）。无「上滑取消」。 */}
        {listening && (
          <div className="live-recording-panel" data-testid="recording-panel" data-no-stage-tap>
            <div className="live-recording-wave" style={{ ["--level" as never]: level }} aria-hidden>
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
            <button type="button" className="live-recording-send" aria-label={UI_TEXT.recordingSend} onPointerUp={endPtt} onPointerCancel={endPtt}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            </button>
            <div className="live-recording-meta">
              <span>{UI_TEXT.recordingSend}</span>
              <span className="live-recording-timer" data-testid="recording-timer">{formatDuration(recordMs)}</span>
            </div>
          </div>
        )}

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
            className="live-mobile-circle"
            data-testid="gift"
            aria-label={UI_TEXT.gift}
            title={UI_TEXT.gift}
            onClick={onGift}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="8" width="18" height="13" rx="2" />
              <path d="M12 8v13M3 12h18M12 8c-1.5-3-5-3.5-5-1.2C7 8 9.5 8 12 8zM12 8c1.5-3 5-3.5 5-1.2C17 8 14.5 8 12 8z" />
            </svg>
          </button>
          <button
            type="button"
            className="live-mobile-mic live-mobile-mic-round"
            data-testid="ptt"
            data-active={vm.phase === "listening"}
            aria-label={UI_TEXT.mic}
            onPointerDown={onPttDown}
            onPointerUp={endPtt}
            onPointerCancel={endPtt}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </button>
          {/*
           * S6f §2：倾听声波（随输入音量跳动）；文字输入时也显示「正在听」。
           * freeze-fix4 §2：同桌面——固定宽度槽位，避免声波挤动 PTT 按钮。
           */}
          <span className="live-wave-slot">
            {listening && (
              <span className="live-wave" data-testid="listening-wave" style={{ ["--level" as never]: level }} aria-hidden>
                <i />
                <i />
                <i />
                <span className="live-wave-label">{UI_TEXT.listening}</span>
              </span>
            )}
          </span>
        </form>

        {vm.error && vm.debugMode && <p className="live-error">{`${vm.error.code}: ${vm.error.message}`}</p>}
        <span className="live-status" data-testid="status">
          {vm.connection === "open" ? "" : UI_TEXT.connecting}
        </span>
      </div>
    </main>
  );
}

/** S6u §3：录音面板计时显示（mm:ss，VT323）。 */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
