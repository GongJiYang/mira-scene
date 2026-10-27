/**
 * S6h §1：`summarize(records, now)` 纯函数——把观测记录汇总成页面要的四块。
 *
 * 契约：对任意输入不抛错；只输出白名单字段（ sanitize 已保证）。
 */
import type { SanitizedRecord } from "./sanitize";

/** 一轮的阶段时间线（相对 turn_start 的毫秒）。 */
export type TurnTimeline = {
  turnId: number;
  sessionId?: string;
  startedAt: number;
  sttMs?: number;
  llmFirstBeatMs?: number;
  ttsFirstAudioMs?: number;
  playbackMs?: number;
  endMs?: number;
  endReason?: string;
  aborted: boolean;
  failed: boolean;
};

export type StageStats = {
  stage: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
};

export type ErrorCount = {
  event: string;
  code?: string;
  category?: string;
  count: number;
  count5m: number;
};

export type ModelCallStats = {
  port: string;
  count: number;
  failed: number;
  avgMs?: number;
};

export type ObsSummary = {
  now: number;
  bufferSize: number;
  turns: TurnTimeline[];
  stages: StageStats[];
  errors: ErrorCount[];
  modelCalls: ModelCallStats[];
};

/** 错误 / 兜底类事件（用于计数面板）。 */
const ERROR_EVENTS = new Set([
  "turn_failed",
  "fallback_used",
  "media_failed",
  "provider_fallback",
  "quota_exceeded",
  "bad_message",
  "message_too_large",
  "upgrade_rejected",
  "handler_failed",
  "ws_error",
  "unknown_session",
  "unknown_character",
  "stale_turn",
  "voice_fallback",
  "tts_pace_warning",
  "llm_beat_warning",
  // S6l-fix1 §0：换背景失败 / 被拒计入错误统计（观测页可见）。
  "scene_failed",
  "scene_rejected",
]);

const FIVE_MIN_MS = 5 * 60 * 1000;
const MAX_TURNS = 20;

/** 把一轮里各阶段事件转成相对毫秒数。 */
function buildTimelines(records: SanitizedRecord[]): TurnTimeline[] {
  // 以 (sessionId, turnId) 聚合；turnId 在会话内单调递增，跨会话可能重复。
  const byTurn = new Map<string, { turnId: number; sessionId?: string; records: SanitizedRecord[] }>();
  for (const record of records) {
    if (record.turnId === undefined || record.turnId === 0) continue;
    const key = `${record.sessionId ?? ""}:${record.turnId}`;
    let bucket = byTurn.get(key);
    if (bucket === undefined) {
      bucket = { turnId: record.turnId, sessionId: record.sessionId, records: [] };
      byTurn.set(key, bucket);
    }
    bucket.records.push(record);
  }

  const timelines: TurnTimeline[] = [];
  for (const bucket of byTurn.values()) {
    // 同一轮可能有多条 turn_start（重试/异常）；取最早一条作为起点。
    const starts = bucket.records.filter((r) => r.event === "turn_start");
    if (starts.length === 0) continue;
    const start = Math.min(...starts.map((r) => r.ts));
    const line: TurnTimeline = {
      turnId: bucket.turnId,
      sessionId: bucket.sessionId,
      startedAt: start,
      aborted: false,
      failed: false,
    };
    for (const r of bucket.records) {
      const rel = r.ts - start;
      switch (r.event) {
        case "stt_done":
          if (line.sttMs === undefined) line.sttMs = rel;
          break;
        case "llm_first_beat":
          if (line.llmFirstBeatMs === undefined) line.llmFirstBeatMs = rel;
          break;
        case "tts_first_audio":
          if (line.ttsFirstAudioMs === undefined) line.ttsFirstAudioMs = rel;
          break;
        case "playback_started":
          if (line.playbackMs === undefined) {
            // 优先用客户端上报的 clientMs（端到端视角），否则用服务端相对时间。
            const clientMs = typeof r.detail?.clientMs === "number" ? r.detail.clientMs : null;
            line.playbackMs = clientMs ?? rel;
          }
          break;
        case "turn_end":
          line.endMs = rel;
          if (typeof r.detail?.reason === "string") line.endReason = r.detail.reason;
          break;
        case "turn_aborted":
          line.aborted = true;
          if (line.endMs === undefined) line.endMs = rel;
          break;
        case "turn_failed":
          line.failed = true;
          break;
        default:
          break;
      }
    }
    timelines.push(line);
  }

  timelines.sort((a, b) => a.startedAt - b.startedAt);
  return timelines.slice(-MAX_TURNS);
}

/** p50 / p95 / max。空数组返回 undefined。 */
function quantiles(values: number[]): { p50: number; p95: number; max: number; count: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1] ?? 0,
    count: sorted.length,
  };
}

function buildStages(turns: TurnTimeline[]): StageStats[] {
  const defs: { stage: string; pick: (t: TurnTimeline) => number | undefined }[] = [
    { stage: "stt", pick: (t) => t.sttMs },
    { stage: "llm_first_beat", pick: (t) => t.llmFirstBeatMs },
    // 首包延迟（turn_start → tts_first_audio）是重点。
    { stage: "first_audio", pick: (t) => t.ttsFirstAudioMs },
    { stage: "playback", pick: (t) => t.playbackMs },
    { stage: "turn_total", pick: (t) => t.endMs },
  ];
  const out: StageStats[] = [];
  for (const { stage, pick } of defs) {
    const values: number[] = [];
    for (const turn of turns) {
      const v = pick(turn);
      if (v !== undefined && Number.isFinite(v) && v >= 0) values.push(v);
    }
    const q = quantiles(values);
    if (q !== null) out.push({ stage, count: q.count, p50: q.p50, p95: q.p95, max: q.max });
  }
  return out;
}

function buildErrors(records: SanitizedRecord[], now: number): ErrorCount[] {
  const cutoff = now - FIVE_MIN_MS;
  const counts = new Map<string, ErrorCount>();
  for (const r of records) {
    if (!ERROR_EVENTS.has(r.event)) continue;
    const code = typeof r.detail?.code === "string" ? r.detail.code : undefined;
    const category = typeof r.detail?.category === "string" ? r.detail.category : undefined;
    const key = `${r.event}|${code ?? ""}|${category ?? ""}`;
    let entry = counts.get(key);
    if (entry === undefined) {
      entry = { event: r.event, code, category, count: 0, count5m: 0 };
      counts.set(key, entry);
    }
    entry.count += 1;
    if (r.ts >= cutoff) entry.count5m += 1;
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

function buildModelCalls(records: SanitizedRecord[]): ModelCallStats[] {
  const stats = new Map<string, { count: number; failed: number; msSum: number; msCount: number }>();
  const bump = (port: string, ok: boolean, ms?: number): void => {
    let entry = stats.get(port);
    if (entry === undefined) {
      entry = { count: 0, failed: 0, msSum: 0, msCount: 0 };
      stats.set(port, entry);
    }
    entry.count += 1;
    if (!ok) entry.failed += 1;
    if (ms !== undefined && Number.isFinite(ms) && ms >= 0) {
      entry.msSum += ms;
      entry.msCount += 1;
    }
  };
  /** 耗时优先取顶层 `ms`，否则回落 detail.duration_ms（commandcode 的 usage 事件带）。 */
  const msOf = (r: SanitizedRecord): number | undefined => {
    if (typeof r.ms === "number") return r.ms;
    return typeof r.detail?.duration_ms === "number" ? r.detail.duration_ms : undefined;
  };

  for (const r of records) {
    if (r.event === "fish_call") {
      const port = typeof r.detail?.port === "string" ? r.detail.port : "auto";
      bump(port, true, msOf(r));
      continue;
    }
    if (r.event === "llm_usage") {
      bump("llm", true, msOf(r));
      continue;
    }
    if (r.event === "tts_synthesized") {
      bump("tts", true, msOf(r));
      continue;
    }
    if (r.event === "media_scheduled") {
      bump("image", true, msOf(r));
      continue;
    }
    if (r.event === "media_failed") {
      bump("image", false, msOf(r));
      continue;
    }
    if (r.event === "provider_fallback") {
      const port = typeof r.detail?.port === "string" ? r.detail.port : "unknown";
      bump(port, false, msOf(r));
      continue;
    }
  }

  return [...stats.entries()]
    .map(([port, s]) => ({
      port,
      count: s.count,
      failed: s.failed,
      avgMs: s.msCount > 0 ? Math.round(s.msSum / s.msCount) : undefined,
    }))
    .sort((a, b) => a.port.localeCompare(b.port));
}

/** 主入口：对任意输入不抛错。 */
export function summarize(records: SanitizedRecord[], now: number): ObsSummary {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const safeRecords = Array.isArray(records) ? records : [];
  const turns = buildTimelines(safeRecords);
  return {
    now: safeNow,
    bufferSize: safeRecords.length,
    turns,
    stages: buildStages(turns),
    errors: buildErrors(safeRecords, safeNow),
    modelCalls: buildModelCalls(safeRecords),
  };
}
