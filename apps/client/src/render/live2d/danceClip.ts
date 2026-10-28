/**
 * 跳舞片段（Grok 绿幕视频抠像）与常驻 Live2D 的配准（纯函数）。
 *
 * 片段首帧由 Live2D 预览截图生成，离线把视频首帧的人物掩码与 Live2D 截图配准（掩码 IoU 0.966），
 * 得到视频矩形相对「模型可见包围盒」的位置。所有量以**包围盒高度**为单位、水平以包围盒中心为基准，
 * 因此任意画布尺寸 / 桌面与手机构图下都能换算出同一个对齐位置。
 *
 * 实测依据（2026-10-28）：预览页画布 772×1888、`FIT_PRESETS.desktop` 下，`MODEL_BOUNDS` 投影
 * 与截图像素包围盒水平一致、垂直差 7px（0.5%），故直接用投影而不读画面像素。
 */
import { fitModel, MODEL_BOUNDS, type FitPreset } from "./cubism/fit";

/** 视频矩形相对模型可见包围盒（单位：包围盒高度；`centerX` 相对包围盒水平中心）。 */
export const DANCE_ALIGN = {
  centerX: -0.0041,
  top: -0.15637,
  width: 0.71106,
  height: 1.30835,
} as const;

/** 舞蹈片段时长（秒）：三段 Grok 片段首尾相接。 */
export const DANCE_CLIP_SEC = 18.1;

export type PxRect = { left: number; top: number; width: number; height: number };

/** 模型可见包围盒在画布中的位置（CSS 像素，原点为画布左上角）。 */
export function modelBoundsRect(canvasW: number, canvasH: number, preset: FitPreset): PxRect {
  const fit = fitModel(canvasW, canvasH, MODEL_BOUNDS, preset);
  // 归一化画布高 2.0 ↔ canvasH 像素；原点在画布中心，Y 向上。
  const half = canvasH / 2;
  const toX = (nx: number): number => canvasW / 2 + nx * half;
  const toY = (ny: number): number => half - ny * half;
  const left = toX(MODEL_BOUNDS.left * fit.scale + fit.x);
  const right = toX(MODEL_BOUNDS.right * fit.scale + fit.x);
  const top = toY(MODEL_BOUNDS.top * fit.scale + fit.y);
  const bottom = toY(MODEL_BOUNDS.bottom * fit.scale + fit.y);
  return { left, top, width: right - left, height: bottom - top };
}

/** 跳舞视频应绘制的位置（CSS 像素，相对画布左上角），使视频首帧与 Live2D 重合。 */
export function danceVideoRect(canvasW: number, canvasH: number, preset: FitPreset): PxRect {
  const bounds = modelBoundsRect(canvasW, canvasH, preset);
  const h = bounds.height;
  const width = DANCE_ALIGN.width * h;
  const centerX = bounds.left + bounds.width / 2 + DANCE_ALIGN.centerX * h;
  return {
    left: centerX - width / 2,
    top: bounds.top + DANCE_ALIGN.top * h,
    width,
    height: DANCE_ALIGN.height * h,
  };
}

export const DANCE_WEBM = "/characters/yuna/dance/dance.webm";
export const DANCE_MOV = "/characters/yuna/dance/dance.mov";

/**
 * Safari（含 iOS 上的所有浏览器内核）用 HEVC 带透明通道的 .mov；其余用 VP9 透明 WebM。
 * 按 UA 首选；加载失败时 `DanceLayer` 会换另一种格式重试。
 */
export function danceVideoSrc(userAgent: string): string {
  const isAppleWebKit = /AppleWebKit/i.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/i.test(userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(userAgent);
  return isAppleWebKit || isIOS ? DANCE_MOV : DANCE_WEBM;
}
