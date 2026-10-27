/**
 * 剧情镜头 → Live2D 舞台取景（S6g-A §3.1）。
 *
 * 纯函数：把协议里的 `Camera`（`close_up` / `wide` / null）映射成舞台的
 * `{ scale, tx, ty }`（相对 live 全身构图的缩放与平移，作用在 Live2D 画布外层容器）。
 *
 * - `wide` / null：全身（缩放 1，不额外平移）——即 `LIVE_FIT_PRESETS` 的默认构图。
 * - `close_up`：推近到半身，脸落在画面上 1/3 处。
 *
 * 桌面 / 手机各一组常量（用户可在截图核对后调整）。
 * 不依赖 DOM / React，可单测。
 */
import type { Camera } from "@mira/protocol";

/** 舞台方向：桌面横版 / 手机竖版。 */
export type StageOrientation = "landscape" | "portrait";

/**
 * 一档镜头的取景参数。
 * - `scale`：相对全身构图的缩放（>1 推近）。
 * - `tx` / `ty`：缩放后画布容器的平移，单位是画布宽/高的比例（+ 向右 / 向下）。
 */
export type CameraTransform = { scale: number; tx: number; ty: number };

/** 全身（wide / null）：不缩放、不平移。 */
export const WIDE_TRANSFORM: CameraTransform = { scale: 1, tx: 0, ty: 0 };

/**
 * 半身特写（close_up）的取景常量。
 *
 * 目标：把人物推近到半身，脸在画面上 1/3 处。
 * - 桌面：人物在全身构图里高约画面 80%、中心 56% 高处；放大 1.9 倍后，
 *   把画面再往下拉一点，让脸落到上 1/3。
 * - 手机：全身构图高约 62%、中心 66% 高处；放大倍数与纵向偏移单独取一组。
 */
export const CLOSE_UP_TRANSFORM: Record<StageOrientation, CameraTransform> = {
  landscape: { scale: 1.9, tx: 0, ty: 0.14 },
  portrait: { scale: 1.7, tx: 0, ty: 0.1 },
};

/** `camera` + 方向 → 取景变换（纯函数）。`wide` / null 恒为全身。 */
export function cameraFor(camera: Camera | null, orientation: StageOrientation): CameraTransform {
  if (camera === "close_up") return CLOSE_UP_TRANSFORM[orientation];
  return WIDE_TRANSFORM;
}
