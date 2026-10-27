/**
 * 镜头变换（架构关卡 §3：必须是纯函数，写单测）。
 *
 * `cameraTransform(camera, progress) → { scale, tx, ty }`
 * - close_up：progress 0→1 时从 1.0 放大到 1.18，并把角色脸部（约画面 (0.5, 0.28) 处）
 *   推到画面中心。tx / ty 是相对舞台尺寸的比例（外壳乘 100 做 CSS 百分比平移）。
 * - wide / null：恢复 1.0。
 */
export const CAMERA_PUSH_SCALE = 1.18;
export const CAMERA_PUSH_MS = 800;
/** 角色脸部在画面里的相对位置（§4）。 */
export const CAMERA_FACE = { x: 0.5, y: 0.28 } as const;

export type CameraTransform = { scale: number; tx: number; ty: number };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

export function cameraTransform(camera: "wide" | "close_up" | null, progress: number): CameraTransform {
  if (camera !== "close_up") return { scale: 1, tx: 0, ty: 0 };
  const p = clamp01(progress);
  const scale = 1 + (CAMERA_PUSH_SCALE - 1) * p;
  // 以画面中心为 transform-origin：缩放后脸部下移到中心所需的位移（相对舞台高度）。
  const ty = (0.5 - CAMERA_FACE.y) * CAMERA_PUSH_SCALE * p;
  return { scale, tx: 0, ty };
}
