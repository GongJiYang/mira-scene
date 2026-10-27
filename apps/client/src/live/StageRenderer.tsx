/**
 * 舞台渲染器（S6b §3；S6g-A §3 补齐镜头 / 特效 / 剧情媒体）。
 *
 * D43：只剩忧奈（Live2D）。原来按 `renderer.kind` 选渲染方式的分支已删除。
 *
 * 状态机 B 的输出（phase / emotion / mouth / look）接到 `yunaParams`；
 * 口型继续由音量驱动（D34）——`mouth` 已由 B 根据 AnalyserNode 的 RMS 算好。
 *
 * S6g-A §3 补上：
 * - 镜头（`cameraFor`）：`close_up` 推近 / `wide` 回全身（600ms 缓动）；
 * - 特效（`stream_dim` 变暗 + `hearts` 爱心）：来自剧情节点，打断不撤销；
 * - reveal 截图弹窗（`ScreenshotCard`）；
 * - ending 视频（`StoryVideo` + `videoReducer`）。
 *
 * 本组件只做渲染，不含决策：参数全部来自纯函数。
 */
import { useEffect, useRef, useState } from "react";
import type { Camera, Emotion, Fx } from "@mira/protocol";
import type { StagePerformance, StagePhase } from "../view/useStageViewModel";
import { createYunaRenderer, YunaLoadError, type YunaRendererHandle } from "../render/live2d/cubism/yunaRenderer";
import { cameraFor, type StageOrientation } from "../render/live2d/cameraFor";
import { yunaParams } from "../render/live2d/yunaParams";
import { toYunaEmotion } from "./emotionMap";
import { StoryVideo } from "../stage/StoryVideo";
import {
  initialVideoState,
  turnIdFromStoryEventId,
  videoReducer,
  type VideoState,
} from "../state/storyMedia";
import { ScreenshotCard } from "./ScreenshotCard";
import type { Visual } from "../state";
import type { StoryMediaStatus } from "../state/storyMedia";

/** S6c §5：新背景交叉淡入时长（毫秒）。 */
const BG_CROSSFADE_MS = 1_200;

/** S6g-A §3.1：镜头推近 / 拉回的缓动时长（毫秒）。 */
export const CAMERA_EASE_MS = 600;

/** S6g-A §3.3：reveal 截图失败 / fallback 的预置图。 */
export const SCREENSHOT_FALLBACK_URL = "/characters/yuna/photo_first_stream.png";

/**
 * S6c §5：背景交叉淡入。背景变化时保留旧图一层，新图在其上从 0 淡入到 1（1.2 秒），
 * 淡入结束后卸掉旧层。URL 不变时只是一层静态背景，不触发动画。
 */
function CrossfadeBackground({ url }: { url: string }) {
  const [layers, setLayers] = useState<{ base: string; top: string }>({ base: url, top: url });

  useEffect(() => {
    setLayers((previous) => {
      if (previous.top === url) return previous;
      // 新图叠在旧图上从 0 淡入；旧图作为底色保留到动画结束。
      return { base: previous.top, top: url };
    });
  }, [url]);

  return (
    <>
      <div className="live-bg" data-bg-layer="base" style={{ backgroundImage: `url(${layers.base})` }} />
      <div
        key={layers.top}
        className="live-bg live-bg-crossfade"
        data-bg-layer="top"
        style={{ backgroundImage: `url(${layers.top})`, animationDuration: `${BG_CROSSFADE_MS}ms` }}
        onAnimationEnd={() => setLayers((previous) => ({ base: previous.top, top: previous.top }))}
      />
    </>
  );
}

/**
 * S6g-A §3.2：剧情特效层（CSS）。
 * - `stream_dim`：舞台叠一层 40% 暗色（背景灯光变暗）；弹幕区在舞台之外，不受影响；
 * - `hearts`：舞台暖色光晕（爱心参数由 `yunaParams` 的 `ParamHeart` 驱动皮套）。
 *
 * 特效随剧情节点保持，打断不撤销（属剧情层，来自 A 的 visual.fx）。
 */
function FxLayers({ fx }: { fx: Fx | null }) {
  return (
    <>
      {fx === "stream_dim" && <div className="live-fx-dim" data-testid="fx-stream-dim" aria-hidden />}
      {fx === "hearts" && <div className="live-fx-hearts" data-testid="fx-hearts" aria-hidden />}
    </>
  );
}

/**
 * S6g-A §3.4：ending 剧情视频的控制器。
 * 从状态机 C 的视频槽位 + A 的当前轮次驱动 `videoReducer`：
 * - 视频槽位 shown 且带 url → LOAD；
 * - 打断（turnId 变化）→ TURN（200ms 淡出暂停，不恢复）；
 * - canplay → CANPLAY（playing）；ended → ENDED；error → ERROR。
 */
function useVideoController(video: { status: StoryMediaStatus; storyEventId: string | null; media: { url?: string } | null }, turnId: number): {
  state: VideoState;
  dispatch: (action: Parameters<typeof videoReducer>[1]) => void;
} {
  const [state, setState] = useState<VideoState>(initialVideoState);
  const dispatch = (action: Parameters<typeof videoReducer>[1]): void => setState((current) => videoReducer(current, action));

  // 轮次变化（打断）→ TURN：停止并淡出，不恢复。
  useEffect(() => {
    dispatch({ type: "TURN", turnId });
  }, [turnId]);

  // 视频槽位就绪 → LOAD（同一 storyEventId 只加载一次，reducer 幂等）。
  useEffect(() => {
    if (video.status !== "shown" || video.storyEventId === null) return;
    const url = video.media?.url;
    if (!url) return;
    const eventTurn = turnIdFromStoryEventId(video.storyEventId);
    if (eventTurn === null) return;
    dispatch({ type: "LOAD", eventId: video.storyEventId, turnId: eventTurn, url });
  }, [video.status, video.storyEventId, video.media?.url]);

  return { state, dispatch };
}

/** 忧奈 Live2D：背景 + 画布 + 镜头 + 特效。 */
function Live2dStage({
  phase,
  emotion,
  performance,
  visual,
  background,
  orientation,
}: {
  phase: StagePhase;
  emotion: Emotion;
  performance: StagePerformance;
  visual: Visual;
  background: string;
  orientation: StageOrientation;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef({ phase, emotion, performance, visual });
  frameRef.current = { phase, emotion, performance, visual };

  // S6g-A §3.2：hearts 特效进入时刻（0.4s 渐入用）。
  const heartRef = useRef({ active: false, since: 0 });
  // S6g-A §4.3：silentAction 进入时刻（抱熊渐入渐出用）。
  const silentRef = useRef<{ action: string | null; sinceMs: number }>({ action: null, sinceMs: 0 });

  // S6f §2：相位计时（phaseSinceSec / idleSinceSec / 首句惊讶 / 待机 seed）。
  const clockRef = useRef({
    phaseSince: 0,
    idleSince: 0,
    firstSpokeAt: null as number | null,
    seed: 0.5,
    lastPhase: phase,
    lastAt: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let handle: YunaRendererHandle | null = null;
    let disposed = false;

    void createYunaRenderer({
      canvas,
      fitMode: "live",
      frame: () => {
        const { phase: currentPhase, emotion: currentEmotion, performance: current, visual: currentVisual } = frameRef.current;
        // 注意：这里不能用名为 `performance` 的局部变量，否则会遮住全局 performance。
        const nowMs = typeof globalThis.performance !== "undefined" ? globalThis.performance.now() : Date.now();
        const tSec = nowMs / 1000;
        const yunaEmotion = toYunaEmotion(currentEmotion);
        const blinkOpen = current.blink === "closed" ? 0 : current.blink === "half" ? 0.5 : 1;

        // S6f §2：相位计时推进（纯本地，不依赖 B 的绝对时刻——phase 变化时重置）。
        const clock = clockRef.current;
        if (clock.lastPhase !== currentPhase) {
          clock.phaseSince = 0;
          clock.idleSince = 0;
          clock.lastPhase = currentPhase;
          if (currentPhase === "idle") clock.seed = Math.random();
        } else if (clock.lastAt > 0) {
          const dt = (nowMs - clock.lastAt) / 1000;
          clock.phaseSince += dt;
          if (currentPhase === "idle") clock.idleSince += dt;
        }
        clock.lastAt = nowMs;

        // S6f §2：首句回话开始时刻（speaking 第一次出现）。
        if (currentPhase === "speaking" && clock.firstSpokeAt === null) clock.firstSpokeAt = nowMs;
        const firstSpokeSinceSec = clock.firstSpokeAt === null ? undefined : (nowMs - clock.firstSpokeAt) / 1000;

        // S6g-A §3.2：hearts 特效进入时刻（0.4s 渐入）。
        const heart = currentVisual.fx === "hearts";
        if (heart && !heartRef.current.active) heartRef.current = { active: true, since: nowMs };
        if (!heart) heartRef.current.active = false;

        // S6g-A §4.3：silentAction 进入时刻（抱熊 0→1→0 渐变）。
        const action = current.activeAction?.action ?? null;
        if (action !== silentRef.current.action) silentRef.current = { action, sinceMs: nowMs };
        const silentActionSinceSec = (nowMs - silentRef.current.sinceMs) / 1000;

        return {
          params: yunaParams({
            phase: currentPhase,
            emotion: yunaEmotion,
            mouth: current.mouth,
            blinkOpen,
            tSec,
            phaseSinceSec: clock.phaseSince,
            idleSinceSec: clock.idleSince,
            firstSpokeSinceSec,
            silentAction: action,
            silentActionSinceSec,
            heart,
            heartSinceSec: (nowMs - heartRef.current.since) / 1000,
            seed: clock.seed,
          }),
          emotion: yunaEmotion,
          manualBlink: blinkOpen,
        };
      },
    })
      .then((created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        handle = created;
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setError(cause instanceof YunaLoadError ? cause.message : "模型加载失败");
      });

    return () => {
      disposed = true;
      handle?.dispose();
    };
  }, []);

  // S6g-A §3.1：镜头取景（纯函数），作用在画布容器上；600ms 缓动。
  const camera = cameraFor(visual.camera as Camera | null, orientation);

  return (
    <div
      className="live-camera"
      data-testid="live-camera"
      data-camera={visual.camera ?? "wide"}
      style={{
        transform: `scale(${camera.scale}) translate(${camera.tx * 100}%, ${camera.ty * 100}%)`,
        transitionDuration: `${CAMERA_EASE_MS}ms`,
      }}
    >
      <CrossfadeBackground url={background} />
      {/* S6b §3：脚下柔和的椭圆接触阴影（宽约人物宽度 70%，半透明深紫），避免人物悬空。 */}
      <div className="live-contact-shadow" data-testid="contact-shadow" aria-hidden />
      <canvas ref={canvasRef} className="live-live2d-canvas" data-testid="yuna-canvas" />
      <FxLayers fx={visual.fx as Fx | null} />
      {error !== null && (
        <p className="live-error" data-testid="yuna-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** S6g-A §3.3：reveal 截图弹窗（在舞台之上、镜头之外，不被镜头缩放影响）。 */
function StageStoryMedia({
  storyMedia,
  turnId,
}: {
  storyMedia: {
    status: StoryMediaStatus;
    media: { url?: string } | null;
    video: { status: StoryMediaStatus; storyEventId: string | null; media: { url?: string } | null };
  };
  turnId: number;
}) {
  const video = useVideoController(storyMedia.video, turnId);
  const videoUrl = storyMedia.video.media?.url ?? null;
  // 注意：`<video>` 必须挂上才能触发 canplay → CANPLAY → playing。
  // 因此只要视频槽位 shown 且有 url 就挂载 `<video>`；可见性由 playing 决定。
  const videoMounted = videoUrl !== null && storyMedia.video.status === "shown";
  const videoVisible = video.state.status === "playing";

  return (
    <>
      <ScreenshotCard
        status={storyMedia.status}
        url={storyMedia.media?.url ?? null}
        fallbackUrl={SCREENSHOT_FALLBACK_URL}
      />
      {videoMounted ? (
        <div
          className="live-story-video"
          data-testid="story-video-wrap"
          data-visible={videoVisible ? "1" : "0"}
          style={videoVisible ? undefined : { visibility: "hidden" }}
        >
          <StoryVideo
            src={videoUrl}
            status={video.state.status}
            onCanPlay={() => video.dispatch({ type: "CANPLAY", eventId: video.state.eventId ?? "" })}
            onEnded={() => video.dispatch({ type: "ENDED", eventId: video.state.eventId ?? "" })}
            onError={() => video.dispatch({ type: "ERROR", eventId: video.state.eventId ?? "" })}
          />
        </div>
      ) : null}
    </>
  );
}

export type StageRendererProps = {
  characterId: string;
  phase: StagePhase;
  visual: Visual;
  performance: StagePerformance;
  storyMedia: {
    status: StoryMediaStatus;
    media: { type: string; id: string; url?: string } | null;
    video: { status: StoryMediaStatus; storyEventId: string | null; media: { url?: string } | null };
  };
  orientation: StageOrientation;
  /** 背景图（来自 pack.stage.background，按方向选）。 */
  backgroundUrl: string;
  /** 当前轮次（S6g-A §3.4：驱动视频打断）。 */
  turnId: number;
};

export function StageRenderer(props: StageRendererProps) {
  return (
    <>
      <Live2dStage
        phase={props.phase}
        emotion={props.visual.emotion}
        performance={props.performance}
        visual={props.visual}
        background={props.backgroundUrl}
        orientation={props.orientation}
      />
      <StageStoryMedia storyMedia={props.storyMedia} turnId={props.turnId} />
    </>
  );
}
