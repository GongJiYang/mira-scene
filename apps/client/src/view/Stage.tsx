import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { StoryMediaStatus } from "../state/storyMedia";
import { initialVideoState, turnIdFromStoryEventId, videoReducer } from "../state/storyMedia";
import { useStageViewModel } from "./useStageViewModel";
import { RainCanvas } from "../stage/RainCanvas";
import { StoryVideo } from "../stage/StoryVideo";
import { cameraTransform, CAMERA_PUSH_MS } from "../stage/camera";
import { developProgress } from "../stage/develop";
import { composeStage, pickStageAsset, STAGE_ASSETS, videoUrl, type StageLayer } from "../stage/layers";
import { photoRect } from "../stage/photoRect";
import "../stage/stage.css";

const BG_FADE_MS = 1_200;
const PHOTO_CENTER_MS = 6_000;
/** 视频从「不可见」到卸载的淡出时长（§5：打断后 300ms 内不可见）。 */
const VIDEO_UNMOUNT_DELAY_MS = 120;

/** S5 §5：`?fail=video` → 视频层直接走失败分支，显示静态图。 */
function readFailVideo(): boolean {
  if (typeof window === "undefined") return false;
  const raw = new URLSearchParams(window.location.search).get("fail");
  if (!raw) return false;
  return raw.split(",").some((value) => value.trim() === "video");
}

/** 量元素的**布局**尺寸（用 offsetWidth/Height，不受舞台相机 transform 影响）。 */
function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (): void => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** 把布尔状态平滑成 0–1 的进度（镜头推拉、宽高比切换等）。 */
function useAnimatedProgress(active: boolean, durationMs: number): number {
  const [progress, setProgress] = useState(active ? 1 : 0);
  const progressRef = useRef(progress);
  useEffect(() => {
    const from = progressRef.current;
    const to = active ? 1 : 0;
    if (from === to) return;
    let raf = 0;
    const start = performance.now();
    const tick = (): void => {
      const ratio = Math.min(1, (performance.now() - start) / durationMs);
      const value = from + (to - from) * ratio;
      progressRef.current = value;
      setProgress(value);
      if (ratio < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, durationMs]);
  return progress;
}

/** 背景两态交叉淡入淡出（1.2s，§3）。 */
function useCrossfade(src: string): { from: string; to: string; progress: number } {
  const [state, setState] = useState({ from: src, to: src, progress: 1 });
  const currentRef = useRef(src);
  useEffect(() => {
    if (currentRef.current === src) return;
    const from = currentRef.current;
    currentRef.current = src;
    let raf = 0;
    const start = performance.now();
    const tick = (): void => {
      const progress = Math.min(1, (performance.now() - start) / BG_FADE_MS);
      setState({ from, to: src, progress });
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [src]);
  return state;
}

/** 照片显影进度：进入 shown 起 3s 内 0 → 1（§6）。 */
function useDevelop(status: StoryMediaStatus, srcKey: string): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (status !== "shown") {
      setProgress(0);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (): void => {
      const value = developProgress(performance.now() - start);
      setProgress(value);
      if (value < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [status, srcKey]);
  return progress;
}

/** 显影完成后照片浮到中央，点击或 6s 后回到桌角（§6）。 */
function usePolaroidMode(status: StoryMediaStatus, srcKey: string): ["corner" | "center", () => void] {
  const [mode, setMode] = useState<"corner" | "center">("corner");
  useEffect(() => {
    if (status !== "shown") {
      setMode("corner");
      return;
    }
    setMode("center");
    const timer = window.setTimeout(() => setMode("corner"), PHOTO_CENTER_MS);
    return () => window.clearTimeout(timer);
  }, [status, srcKey]);
  return [mode, () => setMode("corner")];
}

/** 让元素在 `active` 变 false 后再多留一小会儿，用 CSS 过渡做淡出（视频结束/打断）。 */
function useDelayedUnmount(active: boolean, delayMs: number): boolean {
  const [mounted, setMounted] = useState(active);
  useEffect(() => {
    if (active) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return mounted;
}

type LayerProps = {
  layer: StageLayer;
  photoMode: "corner" | "center";
  photoStyle?: CSSProperties;
  onPhotoClick: () => void;
  onPhotoError: () => void;
};

function StageLayerEl({ layer, photoMode, photoStyle, onPhotoClick, onPhotoError }: LayerProps) {
  if (layer.id === "fx:glow") {
    return <div className="stage-layer stage-glow" style={{ zIndex: layer.z, opacity: layer.opacity }} />;
  }
  if (layer.id === "photo:card") {
    return (
      <div className="stage-layer" style={{ zIndex: layer.z }}>
        <div className="photo-card" data-testid="photo-card" />
      </div>
    );
  }
  if (layer.id === "photo:image") {
    return (
      <div
        className="stage-photo"
        data-mode={photoMode}
        data-testid="stage-photo"
        style={photoStyle}
        onClick={onPhotoClick}
      >
        <img src={layer.src} alt="" style={{ opacity: layer.opacity }} onError={onPhotoError} />
      </div>
    );
  }
  const isChar = layer.id.startsWith("char:");
  return (
    <div
      className="stage-layer"
      style={{ zIndex: layer.z, transform: layer.transform === "none" ? undefined : layer.transform }}
    >
      <img className={isChar ? "stage-breathe" : undefined} src={layer.src} alt="" style={{ opacity: layer.opacity }} />
    </div>
  );
}

export function Stage() {
  const vm = useStageViewModel();
  const frameRef = useRef<HTMLDivElement>(null);
  const stageSize = useElementSize(frameRef);
  const reducedMotion = useReducedMotion();
  // S5 §4 ①：按**舞台框**尺寸（ResizeObserver 量出）选素材，而不是窗口尺寸。
  const orientation = pickStageAsset(stageSize.width, stageSize.height);

  const storyEventId = vm.storyMedia.storyEventId;
  const mediaKey = `${storyEventId ?? ""}:${vm.storyMedia.media?.url ?? vm.storyMedia.media?.id ?? ""}`;
  const develop = useDevelop(vm.storyMedia.status, mediaKey);
  const [photoMode, toCorner] = usePolaroidMode(vm.storyMedia.status, mediaKey);
  const cameraProgress = useAnimatedProgress(vm.visual.camera === "close_up", CAMERA_PUSH_MS);

  const layers = composeStage({
    phase: vm.phase,
    visual: vm.visual,
    performance: vm.performance,
    storyMedia: vm.storyMedia,
    orientation,
    develop,
  });

  const background = layers.find((layer) => layer.id === "bg:main");
  const crossfade = useCrossfade(background?.src ?? "");

  const camera = cameraTransform(vm.visual.camera, cameraProgress);
  const frameStyle = {
    transform: `translate(${(camera.tx * 100).toFixed(3)}%, ${(camera.ty * 100).toFixed(3)}%) scale(${camera.scale.toFixed(4)})`,
  };

  // S5 §4 ②：放大态照片的位置与尺寸由 photoRect 计算，保证不挡脸。
  const photoStyle = useMemo<CSSProperties | undefined>(() => {
    if (photoMode !== "center" || stageSize.width <= 0) return undefined;
    const rect = photoRect(stageSize);
    return {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      right: "auto",
      bottom: "auto",
      transform: "none",
    };
  }, [photoMode, stageSize]);

  // ---- S5 §5：剧情视频 ------------------------------------------------------------------------
  const failVideo = useMemo(readFailVideo, []);
  const [videoState, dispatchVideo] = useReducer(videoReducer, initialVideoState);
  const currentTurnId = vm.debug.turnId;

  // A 换轮（含打断：PTT_DOWN / SUBMIT_TEXT 都让 currentTurnId 自增）→ 视频立即结束、不恢复。
  useEffect(() => {
    dispatchVideo({ type: "TURN", turnId: currentTurnId });
  }, [currentTurnId]);

  // S6a §3：视频从独立槽位驱动（不再占用照片槽位），所以 reveal 的照片在视频播完后仍在。
  const videoSlot = vm.storyMedia.video;
  const videoMedia = videoSlot.status === "shown" && videoSlot.media?.type === "video" ? videoSlot.media : null;
  const videoEventId = videoMedia ? videoSlot.storyEventId : null;

  useEffect(() => {
    if (!videoMedia || !videoEventId) return;
    const turnId = turnIdFromStoryEventId(videoEventId);
    if (turnId === null) return;
    dispatchVideo({ type: "LOAD", eventId: videoEventId, turnId, url: videoUrl(videoMedia) });
    // `?fail=video`：不加载视频，直接按失败处理（显示静态图 + 提示）。
    if (failVideo) dispatchVideo({ type: "ERROR", eventId: videoEventId });
  }, [videoMedia, videoEventId, failVideo]);

  const videoVisible =
    videoState.status === "loading" || videoState.status === "playing";
  const videoMounted = useDelayedUnmount(videoVisible, VIDEO_UNMOUNT_DELAY_MS);

  const { reports } = vm;
  const onPhotoError = useCallback(() => {
    if (storyEventId) reports.mediaLoadFailed(storyEventId);
  }, [reports, storyEventId]);

  const holding = useRef(false);
  const [draft, setDraft] = useState("");

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

  useEffect(() => {
    window.addEventListener("pointerup", endPushToTalk);
    window.addEventListener("pointercancel", endPushToTalk);
    return () => {
      window.removeEventListener("pointerup", endPushToTalk);
      window.removeEventListener("pointercancel", endPushToTalk);
    };
  }, [endPushToTalk]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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

  return (
    <main
      className="stage-root"
      data-testid="stage"
      data-phase={vm.phase}
      data-photo={vm.storyMedia.status}
      data-fx={vm.visual.fx ?? "-"}
      data-camera={vm.visual.camera ?? "-"}
      data-connection={vm.connection}
      data-video={videoState.status}
    >
      <div className="stage-viewport">
        <div className="stage-frame" data-testid="stage-frame" ref={frameRef} style={frameStyle}>
          <div className="stage-layer stage-bg" style={{ zIndex: 0 }}>
            <img src={crossfade.from} alt="" style={{ opacity: 1 - crossfade.progress }} />
            <img src={crossfade.to} alt="" style={{ opacity: crossfade.progress }} />
          </div>

          {/* 雨 canvas 在背景之上、角色之下（§2 层级）。 */}
          <RainCanvas fx={vm.visual.fx} reducedMotion={reducedMotion} />

          {layers
            .filter((layer) => layer.id !== "bg:main")
            .map((layer) => (
              <StageLayerEl
                key={layer.id}
                layer={layer}
                photoMode={photoMode}
                photoStyle={layer.id === "photo:image" ? photoStyle : undefined}
                onPhotoClick={toCorner}
                onPhotoError={onPhotoError}
              />
            ))}

          {/* S5 §5：视频层。同一时刻最多一个；loading 时不可见，playing 时淡入覆盖角色区域。 */}
          {videoMounted && videoState.url !== null && (
            <StoryVideo
              src={videoState.url}
              status={videoState.status}
              onCanPlay={() => videoState.eventId && dispatchVideo({ type: "CANPLAY", eventId: videoState.eventId })}
              onEnded={() => videoState.eventId && dispatchVideo({ type: "ENDED", eventId: videoState.eventId })}
              onError={() => videoState.eventId && dispatchVideo({ type: "ERROR", eventId: videoState.eventId })}
            />
          )}

          {/* S5 §5：失败 → 不出现视频，改显示静态图（+ CSS 动效）。 */}
          {videoState.status === "failed" && (
            <div className="stage-video-fallback" data-testid="video-fallback">
              <img src={`${STAGE_ASSETS}/raw/b3_bg_closing_v.png`} alt="" />
            </div>
          )}
        </div>
      </div>

      <p className="stage-subtitle" data-testid="subtitle">
        {vm.subtitle ?? ""}
      </p>
      {vm.pendingNudge && <p className="stage-hint">（她似乎想说点什么）</p>}
      {videoState.notice !== null && (
        <p className="stage-hint" data-testid="video-notice">
          {videoState.notice}
        </p>
      )}

      <div className="stage-controls">
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
            data-testid="text-input"
          />
          <button type="submit">发送</button>
        </form>
        <p>
          <button
            type="button"
            data-testid="ptt"
            onPointerDown={startPushToTalk}
            onPointerUp={endPushToTalk}
            onPointerLeave={endPushToTalk}
            onPointerCancel={endPushToTalk}
          >
            按住说话
          </button>
          <span className="stage-hint">（或按住空格）</span>
        </p>
        <p className="stage-hint" data-testid="status">
          {`connection=${vm.connection}${vm.micError ? ` · 麦克风不可用：${vm.micError}` : ""}`}
        </p>
        {vm.error && (
          <p>
            {`error ${vm.error.code}: ${vm.error.message} `}
            <button type="button" onClick={vm.intents.retry}>
              重试
            </button>
          </p>
        )}
      </div>
    </main>
  );
}
