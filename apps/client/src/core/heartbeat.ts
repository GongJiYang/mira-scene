/**
 * 连接生命周期常量与纯函数（D8 复核 · Q12）。
 * 心跳：客户端每 15s ping，30s 收不到 pong 判定断线；重连退避加 ±20% 抖动。
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;
export const RECONNECT_JITTER_RATIO = 0.2;

/** 退避时间加 ±20% 随机抖动；random 取 [0, 1)。 */
export function jitteredDelay(baseMs: number, random: number): number {
  const clamped = Math.min(Math.max(random, 0), 1);
  return Math.round(baseMs * (1 - RECONNECT_JITTER_RATIO + 2 * RECONNECT_JITTER_RATIO * clamped));
}

/** 上一次 pong（或连接建立）到现在是否已超过 30s。 */
export function isHeartbeatExpired(lastPongAt: number, now: number): boolean {
  return now - lastPongAt >= HEARTBEAT_TIMEOUT_MS;
}
