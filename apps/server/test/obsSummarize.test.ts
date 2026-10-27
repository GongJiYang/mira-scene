/**
 * S6h §4：summarize 单测。
 * 构造乱序、缺阶段、被打断、重复 turnId 的记录，断言时间线和分位数正确；空输入不报错。
 */
import { describe, expect, it } from "vitest";
import { summarize } from "../src/obs/summarize";
import type { SanitizedRecord } from "../src/obs/sanitize";

const NOW = 1_000_000;

function rec(partial: Partial<SanitizedRecord> & { ts: number; event: string }): SanitizedRecord {
  return { ...partial };
}

describe("summarize", () => {
  it("空输入不报错", () => {
    const out = summarize([], NOW);
    expect(out.turns).toEqual([]);
    expect(out.stages).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(out.modelCalls).toEqual([]);
    expect(out.bufferSize).toBe(0);
  });

  it("一条完整轮次 → 时间线阶段相对 turn_start", () => {
    const t0 = NOW - 10_000;
    const records: SanitizedRecord[] = [
      rec({ ts: t0, event: "turn_start", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 100, event: "stt_done", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 500, event: "llm_first_beat", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 900, event: "tts_first_audio", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 1000, event: "playback_started", sessionId: "s1", turnId: 1, detail: { clientMs: 1100 } }),
      rec({ ts: t0 + 3000, event: "turn_end", sessionId: "s1", turnId: 1, detail: { reason: "done" } }),
    ];
    const out = summarize(records, NOW);
    expect(out.turns).toHaveLength(1);
    const turn = out.turns[0]!;
    expect(turn.turnId).toBe(1);
    expect(turn.sttMs).toBe(100);
    expect(turn.llmFirstBeatMs).toBe(500);
    expect(turn.ttsFirstAudioMs).toBe(900);
    // 客户端上报优先。
    expect(turn.playbackMs).toBe(1100);
    expect(turn.endMs).toBe(3000);
    expect(turn.endReason).toBe("done");
    expect(turn.aborted).toBe(false);
    expect(turn.failed).toBe(false);
  });

  it("乱序输入仍能聚合（按 ts 取 turn_start 起点）", () => {
    const t0 = NOW - 5000;
    const records: SanitizedRecord[] = [
      rec({ ts: t0 + 500, event: "llm_first_beat", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0, event: "turn_start", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 900, event: "tts_first_audio", sessionId: "s1", turnId: 1 }),
    ];
    const out = summarize(records, NOW);
    expect(out.turns).toHaveLength(1);
    expect(out.turns[0]!.llmFirstBeatMs).toBe(500);
    expect(out.turns[0]!.ttsFirstAudioMs).toBe(900);
  });

  it("缺阶段（无 STT 的文字轮）时间线仍有 LLM/TTS，sttMs 为空", () => {
    const t0 = NOW - 5000;
    const records: SanitizedRecord[] = [
      rec({ ts: t0, event: "turn_start", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 400, event: "llm_first_beat", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 800, event: "tts_first_audio", sessionId: "s1", turnId: 1 }),
    ];
    const out = summarize(records, NOW);
    expect(out.turns[0]!.sttMs).toBeUndefined();
    expect(out.turns[0]!.llmFirstBeatMs).toBe(400);
  });

  it("被打断的轮次标红：turn_aborted → aborted=true", () => {
    const t0 = NOW - 5000;
    const records: SanitizedRecord[] = [
      rec({ ts: t0, event: "turn_start", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 200, event: "llm_first_beat", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 300, event: "turn_aborted", sessionId: "s1", turnId: 1, detail: { reason: "interrupt" } }),
    ];
    const out = summarize(records, NOW);
    expect(out.turns[0]!.aborted).toBe(true);
    expect(out.turns[0]!.endMs).toBe(300);
  });

  it("turn_failed → failed=true", () => {
    const t0 = NOW - 5000;
    const records: SanitizedRecord[] = [
      rec({ ts: t0, event: "turn_start", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 100, event: "turn_failed", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 150, event: "turn_end", sessionId: "s1", turnId: 1, detail: { reason: "error" } }),
    ];
    const out = summarize(records, NOW);
    expect(out.turns[0]!.failed).toBe(true);
    expect(out.turns[0]!.endReason).toBe("error");
  });

  it("重复 turnId（同会话同轮多条）合并成一条时间线；跨会话同 turnId 分开", () => {
    const t0 = NOW - 5000;
    const records: SanitizedRecord[] = [
      rec({ ts: t0, event: "turn_start", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 100, event: "beat_sent", sessionId: "s1", turnId: 1 }),
      rec({ ts: t0 + 200, event: "llm_first_beat", sessionId: "s1", turnId: 1 }),
      // 另一个会话的 turnId=1。
      rec({ ts: t0 + 50, event: "turn_start", sessionId: "s2", turnId: 1 }),
      rec({ ts: t0 + 500, event: "tts_first_audio", sessionId: "s2", turnId: 1 }),
    ];
    const out = summarize(records, NOW);
    expect(out.turns).toHaveLength(2);
    const s1 = out.turns.find((t) => t.sessionId === "s1")!;
    const s2 = out.turns.find((t) => t.sessionId === "s2")!;
    expect(s1.llmFirstBeatMs).toBe(200);
    expect(s2.ttsFirstAudioMs).toBe(450);
  });

  it("阶段分位数：p50/p95/max/样本数", () => {
    const records: SanitizedRecord[] = [];
    // 造 10 条文字轮，first_audio 分别 100..1000。
    for (let i = 0; i < 10; i += 1) {
      const t0 = NOW - 100_000 + i * 1000;
      records.push(rec({ ts: t0, event: "turn_start", sessionId: "s1", turnId: i + 1 }));
      records.push(rec({ ts: t0 + (i + 1) * 100, event: "tts_first_audio", sessionId: "s1", turnId: i + 1 }));
    }
    const out = summarize(records, NOW);
    expect(out.turns).toHaveLength(10);
    const firstAudio = out.stages.find((s) => s.stage === "first_audio")!;
    expect(firstAudio.count).toBe(10);
    // p50：索引 floor(0.5*10)=5 → 第 6 个值 600。
    expect(firstAudio.p50).toBe(600);
    expect(firstAudio.p95).toBe(1000);
    expect(firstAudio.max).toBe(1000);
  });

  it("超过 20 轮只保留最近 20 条", () => {
    const records: SanitizedRecord[] = [];
    for (let i = 0; i < 30; i += 1) {
      const t0 = NOW - 100_000 + i * 1000;
      records.push(rec({ ts: t0, event: "turn_start", sessionId: "s1", turnId: i + 1 }));
    }
    const out = summarize(records, NOW);
    expect(out.turns).toHaveLength(20);
    expect(out.turns[0]!.turnId).toBe(11);
    expect(out.turns[19]!.turnId).toBe(30);
  });

  it("错误与兜底按 event+code 计数，5 分钟窗口分开统计", () => {
    const records: SanitizedRecord[] = [
      rec({ ts: NOW - 60_000, event: "fallback_used", detail: { category: "tts" } }),
      rec({ ts: NOW - 10 * 60_000, event: "fallback_used", detail: { category: "tts" } }), // > 5 分钟
      rec({ ts: NOW - 30_000, event: "turn_failed" }),
      rec({ ts: NOW - 10_000, event: "quota_exceeded", detail: { scope: "daily" } }),
    ];
    const out = summarize(records, NOW);
    const fallback = out.errors.find((e) => e.event === "fallback_used")!;
    expect(fallback.count).toBe(2);
    expect(fallback.count5m).toBe(1);
    const failed = out.errors.find((e) => e.event === "turn_failed")!;
    expect(failed.count).toBe(1);
    const quota = out.errors.find((e) => e.event === "quota_exceeded")!;
    expect(quota.count).toBe(1);
  });

  it("模型调用：fish_call 按 detail.port 分端口；llm_usage / tts_synthesized 单独", () => {
    const records: SanitizedRecord[] = [
      rec({ ts: NOW - 1000, event: "fish_call", detail: { port: "stt" }, ms: 200 }),
      rec({ ts: NOW - 1000, event: "fish_call", detail: { port: "stt" }, ms: 400 }),
      rec({ ts: NOW - 1000, event: "fish_call", detail: { port: "tts" }, ms: 100 }),
      rec({ ts: NOW - 1000, event: "llm_usage", ms: 800 }),
      rec({ ts: NOW - 1000, event: "media_failed" }),
    ];
    const out = summarize(records, NOW);
    const stt = out.modelCalls.find((m) => m.port === "stt")!;
    expect(stt.count).toBe(2);
    expect(stt.avgMs).toBe(300);
    const tts = out.modelCalls.find((m) => m.port === "tts")!;
    expect(tts.count).toBe(1);
    const llm = out.modelCalls.find((m) => m.port === "llm")!;
    expect(llm.count).toBe(1);
    expect(llm.avgMs).toBe(800);
    const image = out.modelCalls.find((m) => m.port === "image")!;
    expect(image.count).toBe(1);
    expect(image.failed).toBe(1);
  });

  it("模型调用：llm_usage 的耗时回落 detail.duration_ms（commandcode 无顶层 ms）", () => {
    const records: SanitizedRecord[] = [
      rec({ ts: NOW - 1000, event: "llm_usage", detail: { duration_ms: 2000 } }),
      rec({ ts: NOW - 1000, event: "llm_usage", detail: { duration_ms: 3000 } }),
    ];
    const out = summarize(records, NOW);
    const llm = out.modelCalls.find((m) => m.port === "llm")!;
    expect(llm.count).toBe(2);
    expect(llm.avgMs).toBe(2500);
  });

  it("模型调用：无 turn_start 的孤儿事件不进时间线但不报错", () => {
    const records: SanitizedRecord[] = [
      rec({ ts: NOW - 1000, event: "beat_sent", sessionId: "s1", turnId: 1 }),
      rec({ ts: NOW - 900, event: "turn_end", sessionId: "s1", turnId: 1, detail: { reason: "done" } }),
    ];
    const out = summarize(records, NOW);
    expect(out.turns).toEqual([]);
  });

  it("turnId=0（会话级事件）不进时间线", () => {
    const records: SanitizedRecord[] = [
      rec({ ts: NOW - 1000, event: "session_created", sessionId: "s1", turnId: 0 }),
      rec({ ts: NOW - 500, event: "turn_start", sessionId: "s1", turnId: 1 }),
    ];
    const out = summarize(records, NOW);
    expect(out.turns).toHaveLength(1);
    expect(out.turns[0]!.turnId).toBe(1);
  });

  it("任意畸形输入不抛错（契约式设计后置条件）", () => {
    expect(() => summarize(null as unknown as SanitizedRecord[], Number.NaN)).not.toThrow();
    expect(() => summarize(undefined as unknown as SanitizedRecord[], NOW)).not.toThrow();
    const out = summarize(
      [
        rec({ ts: Number.NaN, event: "turn_start", turnId: 1 }),
        rec({ ts: NOW, event: "turn_end", turnId: 1 }),
      ],
      NOW,
    );
    expect(Array.isArray(out.turns)).toBe(true);
  });
});
