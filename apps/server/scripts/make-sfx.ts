/**
 * 反应音生成（§5）：在 real 模式下用 Fish TTS 合成 2–3 条短反应音，
 * 输出到 `apps/client/public/sfx/react-*.mp3`。
 *
 * Key 缺失（或 Fish 返回 402 等）时，生成一段 300ms 的轻音占位，保证没有 Key 的人也能用。
 * 生成后的文件随仓库提交（本任务按用户要求不执行 git commit）。
 * Key 只从仓库根 `.env` 读取，绝不打印。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFishTts } from "../src/adapters/fish/fishTts";
import { normalizeV1, readRepoEnvFile } from "../src/config";

const REACTIONS: ReadonlyArray<{ file: string; text: string }> = [
  { file: "react-hmm.mp3", text: "嗯……" },
  { file: "react-mm.mp3", text: "唔……" },
  { file: "react-ah.mp3", text: "这样啊。" },
];

const PLACEHOLDER_MS = 300;

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("找不到仓库根目录（pnpm-workspace.yaml）");
    dir = parent;
  }
}

/** 手搓的静音 mp3（MPEG1 Layer3 / 128kbps / 44.1kHz）：没有 ffmpeg 时的兜底。 */
function silentMp3(durationMs: number): Buffer {
  const frameSize = 417;
  const framesPerSec = 44_100 / 1152;
  const count = Math.max(1, Math.round((durationMs / 1000) * framesPerSec));
  const frame = Buffer.alloc(frameSize);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  const out = Buffer.alloc(frameSize * count);
  for (let index = 0; index < count; index += 1) frame.copy(out, index * frameSize);
  return out;
}

/** 300ms 轻音占位：优先 ffmpeg，缺失时退回静音 mp3。 */
function writePlaceholder(file: string): void {
  try {
    const result = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=520:duration=${PLACEHOLDER_MS / 1000}`,
        "-af",
        "volume=0.25",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        file,
      ],
      { stdio: "ignore" },
    );
    if (result.status === 0 && existsSync(file)) return;
  } catch {
    // 忽略：退回静音 mp3。
  }
  writeFileSync(file, silentMp3(PLACEHOLDER_MS));
}

async function main(): Promise<void> {
  const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const outDir = join(root, "apps", "client", "public", "sfx");
  mkdirSync(outDir, { recursive: true });

  const env = readRepoEnvFile();
  const apiKey = (env.FISH_API_KEY ?? "").trim();

  if (apiKey === "") {
    console.log("[make-sfx] 未配置 FISH_API_KEY，生成 300ms 轻音占位");
    for (const reaction of REACTIONS) writePlaceholder(join(outDir, reaction.file));
    return;
  }

  const tts = createFishTts({
    baseUrl: normalizeV1((env.FISH_BASE_URL ?? "").trim() || "https://api.fish.audio"),
    apiKey,
    voiceId: (env.FISH_VOICE_ID ?? "").trim(),
    model: (env.FISH_TTS_MODEL ?? "").trim() || "s2.1-pro-free",
  });

  for (const reaction of REACTIONS) {
    const file = join(outDir, reaction.file);
    try {
      const audio = await tts.synthesize(reaction.text, { emotion: "neutral" }, new AbortController().signal);
      writeFileSync(file, audio.data);
      console.log(`[make-sfx] ${reaction.file} ← Fish（${audio.data.byteLength}B）`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[make-sfx] ${reaction.file} Fish 合成失败（${message}），改用占位轻音`);
      writePlaceholder(file);
    }
  }
}

main().catch((error: unknown) => {
  console.error(`[make-sfx] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
