import type { StoryMediaStatus } from "./storyMedia";
import type { StagePhaseKind } from "./performance";

/**
 * freeze-fix3 §1：截图生成期间的「边翻边聊」铺垫调度（纯函数）。
 *
 * 触发条件：剧情截图（`type: "photo"`）已调度但尚未就绪（C 处于加载中，
 * 照片槽位 `developing`），且 A 为 idle、连接正常。
 * 动作：A 回到 idle 后约 1.5s 发一次 nudge；之后仍未就绪，每隔约 10s 再发一次；
 * 每个截图事件最多 3 次。
 *
 * 与 `state/nudge.ts` 的频率限制**互不约束、互不计数**（§1）。
 * 本模块只做「是否发」的判定；计时与取消由现有时间线外壳驱动。
 */
export const PHOTO_WAITING_FIRST_MS = 1_500;
export const PHOTO_WAITING_INTERVAL_MS = 10_000;
export const PHOTO_WAITING_MAX = 3;

export type PhotoWaitingInput = {
  /** A 的 phase 种类。只有 idle 才允许铺垫。 */
  phase: StagePhaseKind;
  /** C 照片槽位状态。只有 developing（加载中）才算「已调度、未就绪」。 */
  photoStatus: StoryMediaStatus;
  /** 该截图事件已经铺垫过的次数。 */
  fired: number;
  /** 距 A 回到 idle 的时长（毫秒）。 */
  sinceIdleMs: number;
  /** 距上一次铺垫的时长（毫秒）；从未铺垫为 null。 */
  sinceLastMs: number | null;
};

export type PhotoWaitingDecision = { send: boolean; reason: string | null };

/**
 * 纯函数：决定此刻是否发一次铺垫 nudge。
 * - 非 idle / 照片不是 developing / 已达上限 → 不发；
 * - 首次（fired = 0）：距 idle ≥ 1.5s 才发；
 * - 后续：距上次 ≥ 10s 才发。
 */
export function photoWaitingDecision(input: PhotoWaitingInput): PhotoWaitingDecision {
  if (input.phase !== "idle") return { send: false, reason: "phase" };
  if (input.photoStatus !== "developing") return { send: false, reason: "not-waiting" };
  if (input.fired >= PHOTO_WAITING_MAX) return { send: false, reason: "limit" };
  if (input.fired === 0) {
    return input.sinceIdleMs >= PHOTO_WAITING_FIRST_MS ? { send: true, reason: null } : { send: false, reason: "first-delay" };
  }
  if (input.sinceLastMs === null) return { send: true, reason: null };
  return input.sinceLastMs >= PHOTO_WAITING_INTERVAL_MS ? { send: true, reason: null } : { send: false, reason: "interval" };
}
