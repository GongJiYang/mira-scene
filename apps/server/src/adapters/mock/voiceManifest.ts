/**
 * Mock 语音方案 B（S5 §1）：预录片段清单的读取与校验。
 *
 * 契约（架构关卡 §4）：
 * - manifest 文件**不存在** → 视为空表（没有预录片段，全部走占位音）；
 * - manifest 文件**存在但格式非法**（zod 校验失败）→ 直接抛错，服务端启动即失败（开发者的责任）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const VOICE_MANIFEST_VERSION = 1;

/** 音频文件所在子目录（相对 manifest 文件）。 */
export const CLIPS_DIR_NAME = "clips";

const clipSchema = z.object({
  /** 相对 clips/ 的文件名，例如 `<voiceKey>.mp3`。 */
  file: z.string().min(1),
  /** 实际合成的 TTS 文本（含 Fish 情绪标签，仅作核对用）。 */
  text: z.string(),
  emotion: z.string(),
  durationMs: z.number().nonnegative(),
});

export const voiceManifestSchema = z.object({
  version: z.literal(VOICE_MANIFEST_VERSION),
  clips: z.record(z.string(), clipSchema),
});

export type VoiceClip = z.infer<typeof clipSchema>;
export type VoiceManifest = z.infer<typeof voiceManifestSchema>;

export function emptyVoiceManifest(): VoiceManifest {
  return { version: VOICE_MANIFEST_VERSION, clips: {} };
}

/** 已解析的对象 → 校验；失败直接抛错（供启动时调用）。 */
export function parseVoiceManifest(raw: unknown): VoiceManifest {
  const parsed = voiceManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`voice manifest 格式非法：${issue?.path.join(".") ?? "?"} ${issue?.message ?? ""}`.trim());
  }
  return parsed.data;
}

/** 读取 manifest：不存在 → 空表；非法 JSON / 非法结构 → 抛错。 */
export function loadVoiceManifest(path: string): VoiceManifest {
  if (!existsSync(path)) return emptyVoiceManifest();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`voice manifest 不是合法 JSON：${path}（${error instanceof Error ? error.message : String(error)}）`);
  }
  return parseVoiceManifest(raw);
}

/** clips 目录（与 manifest 同级）。 */
export function clipsDirFor(manifestPath: string): string {
  return join(dirname(manifestPath), CLIPS_DIR_NAME);
}

/** 写回 manifest（键排序，便于 diff）；由录制脚本调用。 */
export function writeVoiceManifest(path: string, manifest: VoiceManifest): void {
  const sorted: Record<string, VoiceClip> = {};
  for (const key of Object.keys(manifest.clips).sort()) {
    const clip = manifest.clips[key];
    if (clip) sorted[key] = clip;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: VOICE_MANIFEST_VERSION, clips: sorted }, null, 2)}\n`, "utf8");
}
