import { describe, expect, it } from "vitest";
import { silentLogger, type LogRecord } from "../src/log";
import type { TTSAudio, TTSPort } from "../src/ports";
import { countSpeakableChars, paceCheck, DEFAULT_MP3_BITRATE_BPS } from "../src/quality/paceCheck";
import { withPaceCheck } from "../src/quality/paceGuard";

const BYTES_PER_SEC = DEFAULT_MP3_BITRATE_BPS / 8;

function bytesFor(chars: number, cps: number): number {
  return Math.round((chars / cps) * BYTES_PER_SEC);
}

function audio(bytes: number): TTSAudio {
  return { mime: "audio/mpeg", data: Buffer.alloc(bytes) };
}

describe("paceCheck（§4）", () => {
  it("正常范围 2.6–8.5 字/秒 → ok", () => {
    const text = "雨还在下先坐吧"; // 7 个字
    const result = paceCheck(text, bytesFor(7, 5));
    expect(result.ok).toBe(true);
    expect(result.cps).toBeCloseTo(5, 1);
  });

  it("过快（疑似漏读）→ 不 ok", () => {
    expect(paceCheck("雨还在下先坐吧", bytesFor(7, 20)).ok).toBe(false);
  });

  it("过慢（疑似杂音）→ 不 ok", () => {
    expect(paceCheck("雨还在下先坐吧", bytesFor(7, 1)).ok).toBe(false);
  });

  it("少于 4 个字不检查 → ok", () => {
    expect(paceCheck("嗯", bytesFor(1, 100)).ok).toBe(true);
    expect(paceCheck("好的吧", bytesFor(3, 100)).ok).toBe(true);
  });

  it("忽略 Fish 情绪标签后计数", () => {
    expect(countSpeakableChars("[calm] 雨还在下。")).toBe(5);
    expect(countSpeakableChars("[gentle]先坐吧。")).toBe(4);
  });
});

describe("paceGuard（§4：重试 1 次）", () => {
  function recordingTts(outputs: Array<() => TTSAudio | Promise<TTSAudio>>): { tts: TTSPort; calls: () => number } {
    let calls = 0;
    return {
      tts: {
        async synthesize() {
          const output = outputs[Math.min(calls, outputs.length - 1)];
          calls += 1;
          if (output === undefined) throw new Error("没有更多输出");
          return output();
        },
      },
      calls: () => calls,
    };
  }

  const text = "雨还在下先坐吧"; // 6+ 字

  it("第一次过快、重试通过 → 返回第二次，且不写 warning", async () => {
    const records: LogRecord[] = [];
    const { tts, calls } = recordingTts([
      () => audio(bytesFor(7, 20)),
      () => audio(bytesFor(7, 5)),
    ]);
    const guarded = withPaceCheck(tts, { log: (record) => records.push(record) });
    const result = await guarded.synthesize(text, { emotion: "calm" }, new AbortController().signal);
    expect(result.data.byteLength).toBe(bytesFor(7, 5));
    expect(calls()).toBe(2);
    expect(records).toHaveLength(0);
  });

  it("两次都超出 → 保留第二次并写 warning（不降级）", async () => {
    const records: LogRecord[] = [];
    const { tts, calls } = recordingTts([() => audio(bytesFor(7, 20)), () => audio(bytesFor(7, 30))]);
    const guarded = withPaceCheck(tts, { log: (record) => records.push(record) });
    const result = await guarded.synthesize(text, { emotion: "calm" }, new AbortController().signal);
    expect(result.data.byteLength).toBe(bytesFor(7, 30));
    expect(calls()).toBe(2);
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe("tts_pace_warning");
    expect(records[0]?.detail).toMatchObject({ reason: "still_out_of_range" });
  });

  it("重试抛错 → 返回第一次并写 warning", async () => {
    const records: LogRecord[] = [];
    const { tts } = recordingTts([
      () => audio(bytesFor(7, 20)),
      () => {
        throw new Error("boom");
      },
    ]);
    const guarded = withPaceCheck(tts, { log: (record) => records.push(record) });
    const result = await guarded.synthesize(text, { emotion: "calm" }, new AbortController().signal);
    expect(result.data.byteLength).toBe(bytesFor(7, 20));
    expect(records[0]?.detail).toMatchObject({ reason: "retry_failed" });
  });

  it("通过时只调用一次", async () => {
    const { tts, calls } = recordingTts([() => audio(bytesFor(7, 5))]);
    const guarded = withPaceCheck(tts, { log: silentLogger });
    await guarded.synthesize(text, { emotion: "calm" }, new AbortController().signal);
    expect(calls()).toBe(1);
  });

  it("s3-fix §3：seq0 超出范围时不重试，只请求 1 次并写 warning", async () => {
    const records: LogRecord[] = [];
    const { tts, calls } = recordingTts([() => audio(bytesFor(7, 20))]);
    const guarded = withPaceCheck(tts, { log: (record) => records.push(record) });
    const result = await guarded.synthesize(text, { emotion: "calm", beatSeq: 0 }, new AbortController().signal);
    expect(result.data.byteLength).toBe(bytesFor(7, 20));
    expect(calls()).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe("tts_pace_warning");
    expect(records[0]?.detail).toMatchObject({ reason: "first_beat_no_retry" });
  });

  it("s3-fix §3：seq1 超出范围时仍重试，请求 2 次", async () => {
    const { tts, calls } = recordingTts([() => audio(bytesFor(7, 20)), () => audio(bytesFor(7, 5))]);
    const guarded = withPaceCheck(tts, { log: silentLogger });
    await guarded.synthesize(text, { emotion: "calm", beatSeq: 1 }, new AbortController().signal);
    expect(calls()).toBe(2);
  });
});
