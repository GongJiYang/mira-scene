/**
 * 跳舞演出层：常驻 Live2D ⇄ AI 舞蹈视频（透明）的切换外壳。
 *
 * - 切入（无缝）：视频停在首帧（与 Live2D 已配准、色调差 1%），5 帧交叉淡化后才开始播放，
 *   避免边淡边动产生重影。
 * - 切回（信号切换）：视频末帧是挥手站姿，与 Live2D 蹲姿差别大，淡化盖不住；改用直播信号式
 *   抖动 + 扫描线，在抖动中途替换。
 * - 她开口 / 有新输入 → 立即切回（与动作表预览同一规则）。
 *
 * 位置由纯函数 `danceVideoRect` 按画布尺寸与直播间构图预设算出，随画布 ResizeObserver 重算。
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { LIVE_FIT_PRESETS, livePresetFor } from "../render/live2d/cubism/fit";
import { DANCE_MOV, DANCE_WEBM, danceVideoRect, danceVideoSrc, type PxRect } from "../render/live2d/danceClip";
import { useDanceStore } from "./danceStore";

/** 切入交叉淡化（≈5 帧）。 */
export const DANCE_FADE_MS = 200;
/** 切回的信号抖动总时长与替换时刻。 */
export const DANCE_GLITCH_MS = 240;
const DANCE_SWAP_AT_MS = 120;

function setOpacity(el: HTMLElement, value: number): void {
  el.style.opacity = String(value);
}

function fade(el: HTMLElement, from: number, to: number): Promise<void> {
  setOpacity(el, from);
  if (typeof el.animate !== "function") {
    setOpacity(el, to);
    return Promise.resolve();
  }
  const anim = el.animate([{ opacity: from }, { opacity: to }], { duration: DANCE_FADE_MS, easing: "linear" });
  return anim.finished.then(
    () => setOpacity(el, to),
    () => setOpacity(el, to),
  );
}

function waitFor(el: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve) => el.addEventListener(event, () => resolve(), { once: true }));
}

/** 首帧可用（loadeddata）；加载出错或超时 → reject，由调用方换格式重试或放弃。 */
function loadFirstFrame(el: HTMLVideoElement, timeoutMs = 10_000): Promise<void> {
  if (el.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => done(new Error("dance video load timeout")), timeoutMs);
    const onData = (): void => done();
    const onError = (): void => done(new Error("dance video load error"));
    function done(error?: Error): void {
      window.clearTimeout(timer);
      el.removeEventListener("loadeddata", onData);
      el.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    }
    el.addEventListener("loadeddata", onData);
    el.addEventListener("error", onError);
    el.preload = "auto";
    el.load();
  });
}

/** 直播信号式抖动 + 扫描线，在 `DANCE_SWAP_AT_MS` 处调用 `swap`。 */
function glitch(stage: HTMLElement | null, scan: HTMLElement | null, swap: () => void): void {
  window.setTimeout(swap, DANCE_SWAP_AT_MS);
  if (stage && typeof stage.animate === "function") {
    const xs = [0, 14, -18, 9, -6, 0];
    stage.animate(
      xs.map((x, i) => ({
        translate: `${x}px 0`,
        filter: i === xs.length - 1 ? "none" : `hue-rotate(${i % 2 ? -25 : 25}deg) contrast(1.2)`,
        offset: i / (xs.length - 1),
      })),
      { duration: DANCE_GLITCH_MS, easing: "steps(1, end)" },
    );
  }
  if (scan && typeof scan.animate === "function") {
    scan.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { duration: DANCE_GLITCH_MS + 160 });
  }
}

export function DanceLayer({ canvasRef, busy }: { canvasRef: RefObject<HTMLCanvasElement | null>; busy: boolean }) {
  const active = useDanceStore((state) => state.active);
  const stop = useDanceStore((state) => state.stop);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(false);
  const [rect, setRect] = useState<PxRect | null>(null);
  const [src] = useState(() => danceVideoSrc(typeof navigator === "undefined" ? "" : navigator.userAgent));

  // 视频位置随画布尺寸重算（画布在手机端有顶部偏移，取 offsetLeft/Top）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = (): void => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w <= 0 || h <= 0) return;
      const r = danceVideoRect(w, h, LIVE_FIT_PRESETS[livePresetFor(w)]);
      setRect({ left: canvas.offsetLeft + r.left, top: canvas.offsetTop + r.top, width: r.width, height: r.height });
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasRef]);

  // 她开口或有新输入 → 结束跳舞。
  useEffect(() => {
    if (active && busy) stop();
  }, [active, busy, stop]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    let cancelled = false;

    if (active) {
      void (async () => {
        try {
          await loadFirstFrame(video);
        } catch {
          // 选中的格式播不了（例如非 Safari 内核却拿到 HEVC mov）→ 换另一种格式重试一次，仍失败就放弃跳舞。
          const fallback = video.currentSrc.endsWith(".mov") ? DANCE_WEBM : DANCE_MOV;
          video.src = fallback;
          try {
            await loadFirstFrame(video);
          } catch {
            if (!cancelled) stop();
            return;
          }
        }
        if (cancelled) return;
        video.pause();
        if (video.currentTime !== 0) {
          video.currentTime = 0;
          await waitFor(video, "seeked");
        }
        if (cancelled) return;
        // 停在首帧交叉淡化，淡完才开始播放。
        await Promise.all([fade(canvas, 1, 0), fade(video, 0, 1)]);
        if (cancelled) return;
        shownRef.current = true;
        video.play().catch(() => stop());
      })();
    } else if (shownRef.current) {
      shownRef.current = false;
      glitch(canvas.parentElement, scanRef.current, () => {
        setOpacity(video, 0);
        setOpacity(canvas, 1);
        video.pause();
      });
    } else {
      // 淡入途中被取消：直接复原。
      setOpacity(video, 0);
      setOpacity(canvas, 1);
    }
    return () => {
      cancelled = true;
    };
  }, [active, canvasRef, stop]);

  // 卸载时复原画布。
  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) setOpacity(canvas, 1);
    };
  }, [canvasRef]);

  return (
    <>
      <video
        ref={videoRef}
        className="live-dance-video"
        data-testid="dance-video"
        data-active={active ? "1" : "0"}
        src={src}
        muted
        playsInline
        preload="metadata"
        onEnded={stop}
        aria-hidden
        style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : { display: "none" }}
      />
      <div ref={scanRef} className="live-dance-scan" aria-hidden />
    </>
  );
}
