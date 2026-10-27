/**
 * 口型：/ 音量为 / 唯一时钟（D34 落地方案）。
 *
 * 纯函数，无 DOM、无时钟、无 Web Audio —— 音量由 `core/audioLevel.ts` 的
 * `AudioLevelSource` 读取后喂进来，本模块只负责：
 *   1. `levelToMouth(rms, prev, dtMs)`：把瞬时 RMS 平滑成口型（起音快、释放慢 + 滞回）；
 *   2. `mouthFor(phase, audioPlaying, shape)`：非 speaking 或音频没在播放时一律 closed，
 *      避免口型在音频停下之后还挂在张开状态。
 *
 * 阈值调法：见 `MOUTH_LEVEL_CONFIG`。RMS 是「时域数据平方均值开方」，安静语音大约
 * 0.01–0.05、正常说话 0.05–0.2。因此 0.02（closed/small）与 0.08（small/open）适合
 * 麦距固定的近场录音；若实测偏灵敏，整体上调两档边界即可，滞回宽度同步放大。
 */
import type { MouthShape, StagePhaseKind } from "./performance";

export type MouthLevelConfig = {
  /** 低于它算 closed（滞回带之下）。 */
  closedMax: number;
  /** 高于它算 open（滞回带之上）；中间是 small。 */
  smallMax: number;
  /** 滞回带半宽：上行与下行用不同的边界，防止在阈值附近来回跳。 */
  hysteresis: number;
  /** 起音平滑时间常数（ms）：音量上升时用，约 30ms。 */
  attackMs: number;
  /** 释放平滑时间常数（ms）：音量下降时用，约 80ms。 */
  releaseMs: number;
};

/** §1 的初始阈值（写进配置，说明见文件头）。 */
export const MOUTH_LEVEL_CONFIG: MouthLevelConfig = {
  closedMax: 0.02,
  smallMax: 0.08,
  hysteresis: 0.01,
  attackMs: 30,
  releaseMs: 80,
};

/** §1 在拿不到 AnalyserNode 时的退路：每 120ms 在 small / open 之间交替。 */
export const FALLBACK_MOUTH_INTERVAL_MS = 120;

export type MouthLevel = { shape: MouthShape; smoothed: number };

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/** 无滞回的基准分类；既用于初始判断，也用于从 `prev` 反推上一帧的口型。 */
function baseShape(level: number, config: MouthLevelConfig): MouthShape {
  if (level < config.closedMax) return "closed";
  if (level <= config.smallMax) return "small";
  return "open";
}

/** 带滞回的分类：上行与下行的边界不同，取决于上一帧的口型。 */
function classify(level: number, prevShape: MouthShape, config: MouthLevelConfig): MouthShape {
  const h = config.hysteresis;
  switch (prevShape) {
    case "closed":
      if (level > config.smallMax + h) return "open";
      if (level >= config.closedMax + h) return "small";
      return "closed";
    case "small":
      if (level > config.smallMax + h) return "open";
      if (level < config.closedMax - h) return "closed";
      return "small";
    case "open":
      if (level < config.closedMax - h) return "closed";
      if (level < config.smallMax - h) return "small";
      return "open";
  }
}

/**
 * 音量 → 口型（纯函数）。
 *
 * - 用非对称指数平滑逼近 `rms`：上升走 `attackMs`，下降走 `releaseMs`；
 * - `prev` 是上一帧的平滑值，本函数据此反推上一帧的口型并施加滞回阈值；
 * - `dtMs` 是距上一帧的时长，用于计算平滑系数（<=0 视为不推进）。
 */
export function levelToMouth(
  rms: number,
  prev: number,
  dtMs: number,
  config: MouthLevelConfig = MOUTH_LEVEL_CONFIG,
): MouthLevel {
  const level = clamp01(rms);
  const previous = clamp01(prev);
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
  const tau = level > previous ? config.attackMs : config.releaseMs;
  const alpha = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
  const smoothed = previous + (level - previous) * alpha;
  const shape = classify(smoothed, baseShape(previous, config), config);
  return { shape, smoothed };
}

/**
 * 契约（§3）：非 speaking 状态或音频没在播放时，一律返回 closed。
 * 渲染层只读口型形状，不接触 Web Audio —— 这个函数就是音频世界与表演世界之间的闸门。
 */
export function mouthFor(phase: StagePhaseKind, audioPlaying: boolean, shape: MouthShape): MouthShape {
  if (phase !== "speaking" || !audioPlaying) return "closed";
  return shape;
}

/** §1 退路：speaking 时在 small / open 之间按固定间隔交替。 */
export function fallbackMouth(elapsedMs: number, intervalMs: number = FALLBACK_MOUTH_INTERVAL_MS): MouthShape {
  const step = Math.floor(Math.max(0, elapsedMs) / intervalMs);
  return step % 2 === 0 ? "small" : "open";
}
