/**
 * S5 §5：剧情视频组件（状态机 C 的渲染外壳）。
 *
 * 函数式核心在 `state/storyMedia.ts` 的 `videoReducer`；这里只做外壳该做的事：
 * 挂 `<video>`、监听 canplay / ended / error、跑 5 秒加载超时、被打断时立即暂停。
 */
import { useEffect, useRef } from "react";
import type { VideoStatus } from "../state/storyMedia";

/** §5：超过 5 秒还没到 canplay 就按失败处理。 */
export const VIDEO_LOAD_TIMEOUT_MS = 5_000;

export type StoryVideoProps = {
  src: string;
  status: VideoStatus;
  onCanPlay(): void;
  onEnded(): void;
  onError(): void;
};

export function StoryVideo({ src, status, onCanPlay, onEnded, onError }: StoryVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  /** 一旦 canplay（或报错）落地，超时就不再触发。 */
  const settledRef = useRef(false);
  // 回调存进 ref：超时特效只依赖 src，不因父组件重渲染而重置。
  const canPlayRef = useRef(onCanPlay);
  const errorRef = useRef(onError);
  canPlayRef.current = onCanPlay;
  errorRef.current = onError;

  useEffect(() => {
    settledRef.current = false;
    const timer = window.setTimeout(() => {
      if (settledRef.current) return;
      settledRef.current = true;
      errorRef.current();
    }, VIDEO_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [src]);

  // §5：被打断（dismissed）/ 结束 / 失败 → 立即暂停，不恢复。
  useEffect(() => {
    if (status === "playing" || status === "loading") return;
    videoRef.current?.pause();
  }, [status]);

  const handleReady = (): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    canPlayRef.current();
  };

  return (
    <div className="stage-video" data-testid="story-video" data-status={status}>
      <video
        ref={videoRef}
        src={src}
        muted
        playsInline
        autoPlay
        preload="auto"
        onCanPlay={handleReady}
        onLoadedData={handleReady}
        onPlaying={handleReady}
        onEnded={onEnded}
        onError={() => {
          settledRef.current = true;
          errorRef.current();
        }}
      />
    </div>
  );
}
