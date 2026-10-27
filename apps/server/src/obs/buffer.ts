/**
 * S6h §1：内存环形缓冲（纯函数核心 + 一个可变外壳）。
 *
 * YAGNI：不接 Prometheus / 数据库，不做持久化；容量固定，写满覆盖最旧。
 */
import type { LogRecord } from "../log";
import { sanitize, type SanitizedRecord } from "./sanitize";

export const DEFAULT_CAPACITY = 2000;

export type ObsBuffer = {
  /** 接收一条原始日志记录（先 sanitize 再入环）。 */
  push(record: LogRecord): void;
  /** 从旧到新返回当前缓冲里的全部记录。 */
  snapshot(): SanitizedRecord[];
  /** 当前缓冲条数。 */
  size(): number;
};

export function createObsBuffer(capacity: number = DEFAULT_CAPACITY): ObsBuffer {
  const cap = Math.max(1, Math.floor(capacity));
  const ring: (SanitizedRecord | undefined)[] = new Array(cap);
  let head = 0; // 下一次写入的位置
  let count = 0;

  return {
    push(record) {
      ring[head] = sanitize(record);
      head = (head + 1) % cap;
      if (count < cap) count += 1;
    },
    snapshot() {
      if (count === 0) return [];
      const out: SanitizedRecord[] = [];
      // 最旧的一条在 (head - count + cap) % cap。
      const start = (head - count + cap) % cap;
      for (let i = 0; i < count; i += 1) {
        const item = ring[(start + i) % cap];
        if (item !== undefined) out.push(item);
      }
      return out;
    },
    size() {
      return count;
    },
  };
}
