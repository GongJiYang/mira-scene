/**
 * 预置照片媒体适配器（D27 · 端口/适配器）。
 *
 * 生图要 30–60 秒，本批没有真实生图，用「等待一段可配置的时长后返回可访问地址」
 * 模拟后台异步任务。地址落在客户端 `public/stage/photos/`（由 Vite 从 `assets/raw/` 提供）。
 * 会话层在等待结束后发送剧情层的 `media_ready`。
 */
import type { Media } from "@mira/protocol";
import { createAbortError } from "../../abort";
import type { MediaPort, PresetMediaResult } from "../../ports";

/** 默认等待时长：2.5s（可配置）。 */
export const DEFAULT_PRESET_DELAY_MS = 2_500;

export type PresetMediaOptions = {
  /** 等待多久后判定「就绪」，默认 2.5s。 */
  delayMs?: number;
  /** 照片访问前缀，默认 `/stage/photos`。 */
  basePath?: string;
  /** S5 §5：视频访问前缀，默认 `/stage/videos`。 */
  videoBasePath?: string;
};

/** 媒体类型 → 客户端访问地址（视频是 webm，照片是 png）。 */
export function presetMediaUrl(media: Media, basePath: string, videoBasePath: string): string {
  return media.type === "video" ? `${videoBasePath}/${media.id}.webm` : `${basePath}/${media.id}.png`;
}

export function createPresetMedia(options: PresetMediaOptions = {}): MediaPort {
  const delayMs = options.delayMs ?? DEFAULT_PRESET_DELAY_MS;
  const basePath = options.basePath ?? "/stage/photos";
  const videoBasePath = options.videoBasePath ?? "/stage/videos";

  return {
    preset(media: Media, signal: AbortSignal): Promise<PresetMediaResult> {
      return new Promise<PresetMediaResult>((resolve, reject) => {
        if (signal.aborted) {
          reject(createAbortError());
          return;
        }
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(createAbortError());
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve({ url: presetMediaUrl(media, basePath, videoBasePath), status: "ready" });
        }, delayMs);
        // 不阻塞进程退出（真实运行时定时器会随会话 dispose 取消）。
        timer.unref?.();
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
