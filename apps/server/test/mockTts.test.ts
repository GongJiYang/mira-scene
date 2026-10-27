import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LogRecord } from "../src/log";
import { createMockTts, MP3_MIME, synthesizeWav, WAV_MIME } from "../src/adapters/mock/mockTts";
import { voiceKey } from "../src/adapters/mock/voiceKey";
import { clipsDirFor, VOICE_MANIFEST_VERSION } from "../src/adapters/mock/voiceManifest";

/**
 * S5 §1：Node 集成测试——在临时目录里放一个假 manifest 和假音频文件，验证查表与降级。
 * 不读 Key、不发任何网络请求。
 */
const dirs: string[] = [];

function makeVoiceDir(): { manifestPath: string; clipsDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mira-voice-"));
  dirs.push(dir);
  const clipsDir = clipsDirFor(join(dir, "manifest.json"));
  mkdirSync(clipsDir, { recursive: true });
  return { manifestPath: join(dir, "manifest.json"), clipsDir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createMockTts：预录片段查表（S5 §1）", () => {
  it("命中 → 返回预录 mp3，保留 delayMs 行为", async () => {
    const { manifestPath, clipsDir } = makeVoiceDir();
    const text = "[calm] 雨还在下。";
    const key = voiceKey(text, "calm");
    const bytes = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3, 4]);
    writeFileSync(join(clipsDir, `${key}.mp3`), bytes);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: VOICE_MANIFEST_VERSION,
        clips: { [key]: { file: `${key}.mp3`, text, emotion: "calm", durationMs: 100 } },
      }),
    );

    const tts = createMockTts({ delayMs: 5, manifestPath });
    const started = Date.now();
    const audio = await tts.synthesize(text, { emotion: "calm" }, new AbortController().signal);
    expect(audio.mime).toBe(MP3_MIME);
    expect(audio.data.equals(bytes)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  });

  it("未命中 → 退回占位音，并写一条 voice_fallback（不算错误）", async () => {
    const { manifestPath } = makeVoiceDir();
    writeFileSync(manifestPath, JSON.stringify({ version: VOICE_MANIFEST_VERSION, clips: {} }));
    const records: LogRecord[] = [];

    const tts = createMockTts({ delayMs: 0, manifestPath, log: (record) => records.push(record) });
    const audio = await tts.synthesize("雨还在下。", { emotion: "calm" }, new AbortController().signal);

    expect(audio.mime).toBe(WAV_MIME);
    expect(audio.data.equals(synthesizeWav("雨还在下。"))).toBe(true);
    const fallback = records.filter((record) => record.event === "voice_fallback");
    expect(fallback).toHaveLength(1);
    expect((fallback[0]?.detail as { voiceKey?: string })?.voiceKey).toBe(voiceKey("雨还在下。", "calm"));
  });

  it("manifest 里登记了片段但音频文件缺失 → 也算未命中，走降级", async () => {
    const { manifestPath } = makeVoiceDir();
    const text = "灯光暗下来。";
    const key = voiceKey(text, "warm");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: VOICE_MANIFEST_VERSION,
        clips: { [key]: { file: `${key}.mp3`, text, emotion: "warm", durationMs: 100 } },
      }),
    );

    const tts = createMockTts({ delayMs: 0, manifestPath });
    const audio = await tts.synthesize(text, { emotion: "warm" }, new AbortController().signal);
    expect(audio.mime).toBe(WAV_MIME);
  });

  it("manifest 不存在 → 视为空表，全部走占位音（pnpm dev 无 .env 也能跑通）", async () => {
    const tts = createMockTts({ delayMs: 0, manifestPath: join(tmpdir(), "mira-voice-missing", "manifest.json") });
    const audio = await tts.synthesize("你好", { emotion: "neutral" }, new AbortController().signal);
    expect(audio.mime).toBe(WAV_MIME);
  });

  it("manifest 存在但格式非法 → 创建时直接抛错（服务端启动即失败）", () => {
    const { manifestPath } = makeVoiceDir();
    writeFileSync(manifestPath, JSON.stringify({ version: 1, clips: "not-an-object" }));
    expect(() => createMockTts({ manifestPath })).toThrow(/格式非法/);
  });

  it("manifest 不是合法 JSON → 创建时直接抛错", () => {
    const { manifestPath } = makeVoiceDir();
    writeFileSync(manifestPath, "{ not json");
    expect(() => createMockTts({ manifestPath })).toThrow(/不是合法 JSON/);
  });

  it("AbortSignal 中止时以 AbortError 结束，不产出音频", async () => {
    const tts = createMockTts({ delayMs: 50 });
    const controller = new AbortController();
    const pending = tts.synthesize("你好", { emotion: "neutral" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
