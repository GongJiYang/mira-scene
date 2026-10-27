/**
 * S5 §1：Mock 语音方案 B 的录制脚本。
 *
 * 遍历 `adapters/mock/mockLlm.ts` 的剧本（每个剧情节点 × 每种意图 + 主动开口轮），
 * 把每一句台词用真实 Fish TTS 合成，写入 `assets/voice/clips/<voiceKey>.mp3`，
 * 并把 `{text, emotion, file, durationMs}` 写进 `assets/voice/manifest.json`。
 *
 * 用法：`pnpm voices:record`（仓库根 `.env` 里要有可用的 `FISH_API_KEY`）。
 * 已存在的 key 直接跳过，因此可以重复运行、增量补录。
 *
 * 注意：本脚本会消耗 Fish 额度，**不在任何测试里运行**。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Emotion, StoryNode } from "@mira/protocol";
import { createFishTts } from "../src/adapters/fish/fishTts";
import { composeBeats } from "../src/adapters/mock/mockLlm";
import { voiceKey } from "../src/adapters/mock/voiceKey";
import {
  clipsDirFor,
  loadVoiceManifest,
  writeVoiceManifest,
  type VoiceManifest,
} from "../src/adapters/mock/voiceManifest";
import { applyRepoEnv, loadConfig, resolveVoiceManifestPath } from "../src/config";
import { buildTtsText } from "../src/director/vocab";
import type { Intent } from "../src/intent";
import { createInitialScene } from "../src/story";

/** 能稳定命中每种意图的代表文本（与 `classifyIntent` 的关键词表一致）。 */
const TEXT_BY_INTENT: ReadonlyArray<[Intent, string]> = [
  ["ask_waiting", "你在等谁？"],
  ["ask_photo", "能看看照片吗"],
  ["ask_radio", "你的节目几点开始"],
  ["comfort", "我陪你坐一会儿"],
  ["greeting", "你好"],
  ["other", "今天店里很安静"],
];

const NODES: readonly StoryNode[] = ["arrive", "probe", "reveal", "ending"];

/** 一句「台词 + 情绪」：录制的最小单位。 */
type Line = { say: string; emotion: Emotion };

/** 遍历 Mock 剧本，收集所有需要录制的台词（去重）。 */
export function collectLines(): Line[] {
  const seen = new Set<string>();
  const lines: Line[] = [];
  const push = (say: string, emotion: Emotion): void => {
    if (say === "") return;
    const id = `${emotion}\u0000${say}`;
    if (seen.has(id)) return;
    seen.add(id);
    lines.push({ say, emotion });
  };

  for (const node of NODES) {
    for (const [, userText] of TEXT_BY_INTENT) {
      const scene = { ...createInitialScene(), node };
      for (const beat of composeBeats({ history: [], scene, userText })) {
        push(beat.say, beat.emotion);
      }
    }
  }
  // D32 主动开口轮的两句。
  for (const beat of composeBeats({ history: [], scene: createInitialScene(), userText: "", nudge: true })) {
    push(beat.say, beat.emotion);
  }
  return lines;
}

/** mp3（CBR 128kbps）字节数 → 估算时长（毫秒）。 */
function estimateDurationMs(bytes: number, bitrateKbps = 128): number {
  return Math.round((bytes * 8) / (bitrateKbps * 1000) * 1000);
}

async function main(): Promise<void> {
  applyRepoEnv();
  const config = loadConfig({ ...process.env, PROVIDER_MODE: "real" });
  const { fish } = config.providers;
  if (fish.apiKey === "") {
    throw new Error("缺少 FISH_API_KEY：请在仓库根 .env 里配置后再运行 pnpm voices:record");
  }

  const manifestPath = resolveVoiceManifestPath();
  const clipsDir = clipsDirFor(manifestPath);
  mkdirSync(clipsDir, { recursive: true });

  const manifest: VoiceManifest = loadVoiceManifest(manifestPath);
  const tts = createFishTts({
    baseUrl: fish.baseUrl,
    apiKey: fish.apiKey,
    voiceId: fish.voiceId,
    model: fish.ttsModel,
    log: (record) => console.log(JSON.stringify(record)),
  });

  const lines = collectLines();
  let recorded = 0;
  let skipped = 0;

  for (const { say, emotion } of lines) {
    const text = buildTtsText(emotion, say);
    const key = voiceKey(text, emotion);
    if (manifest.clips[key]) {
      skipped += 1;
      continue;
    }
    const file = `${key}.mp3`;
    const { data } = await tts.synthesize(text, { emotion }, new AbortController().signal);
    writeFileSync(join(clipsDir, file), data);
    manifest.clips[key] = { file, text, emotion, durationMs: estimateDurationMs(data.byteLength) };
    // 每录一句就落盘，中途失败也能续跑。
    writeVoiceManifest(manifestPath, manifest);
    recorded += 1;
    console.log(`recorded ${key} (${emotion}) ${say} → ${file} (${data.byteLength} bytes)`);
  }

  writeVoiceManifest(manifestPath, manifest);
  console.log(`done: recorded=${recorded} skipped=${skipped} total=${lines.length} manifest=${manifestPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
