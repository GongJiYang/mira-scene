/**
 * S6c §6：真实换背景冒烟（`pnpm smoke:scene`）。
 *
 * 只跑一次真实链路：真实场景扩写（按 `LLM_PROVIDER`）+ 真实参考图生图（`/v1/images/edits`，桌面与手机并行）。
 * 打印耗时与 label，**绝不打印任何 Key**；缺 Key 时打印提示并以 0 退出（不算失败）。
 *
 * Key 只从仓库根 `.env` 读取（经 config.loadConfig）。
 * 参考图 = 角色包默认背景（桌面 / 手机），与真实会话一致。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig, readRepoEnvFile } from "../src/config";
import { charactersRoot, loadPack, resolveClientAssetPath } from "../src/characters/pack";
import { composeScenePrompt } from "../src/scene/prompt";
import { parseSceneSpec } from "../src/scene/spec";
import { createSceneWriter } from "../src/scene/writer";
import { defaultOutDir, generateImage } from "../src/adapters/media/imageGen";

/** 生图单张超时（S6c §4：edits 实测约 38.6 秒，留足余量）。 */
const IMAGE_TIMEOUT_MS = 120_000;

/** 用作弹幕文本（命中关键词，交给真实扩写）。 */
const USER_TEXT = "换背景到海边吧";
/** 角色（默认忧奈：Live2D 人物位置固定，最能体现构图锁）。 */
const CHARACTER_ID = "yuna";

function info(message: string): void {
  console.log(`[smoke:scene] ${message}`);
}

async function main(): Promise<void> {
  // .env → 环境；命令行的 PROCESS 环境优先（不覆盖已存在的值）。
  const fileEnv = readRepoEnvFile();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(fileEnv)) {
    if (env[key] === undefined || env[key] === "") env[key] = value;
  }
  env.PROVIDER_MODE = "real";

  const config = loadConfig(env);
  const llmProvider = config.llmProvider;
  const missing: string[] = [];
  if (llmProvider === "commandcode") {
    // commandcode 用本地 cmd 额度，无需 DeepSeek Key。
  } else if (config.providers.deepseek.apiKey === "") {
    missing.push("DEEPSEEK_API_KEY");
  }
  if (config.providers.image.apiKey === "") missing.push("IMAGE_API_KEY");
  if (missing.length > 0) {
    info(`跳过：.env 里缺少 ${missing.join(", ")}（需要真实 Key 才会运行）`);
    return;
  }

  const pack = loadPack(join(charactersRoot(), CHARACTER_ID));
  info(`角色=${pack.id}（${pack.displayName}），LLM=${llmProvider}，生图模型=${config.providers.image.model}`);

  const writer = createSceneWriter({
    provider: llmProvider,
    deepseek: config.providers.deepseek.apiKey !== "" ? config.providers.deepseek : undefined,
    commandcode: { model: config.commandCodeModel },
  });

  const started = performance.now();
  const writeStarted = performance.now();
  const raw = await writer.write(
    { pack, userText: USER_TEXT, nodeLabel: pack.nodes.arrive.label, currentScene: "bedroom" },
    new AbortController().signal,
  );
  const writeMs = performance.now() - writeStarted;

  const parsed = parseSceneSpec(raw);
  if (parsed.kind !== "spec") {
    info(`扩写结果不是合法 spec（kind=${parsed.kind}）：${String(raw).slice(0, 200)}`);
    throw new Error(`真实扩写失败：${parsed.kind}`);
  }
  const spec = parsed.spec;
  info(`扩写 OK：label=「${spec.label}」，耗时 ${Math.round(writeMs)}ms`);
  info(`note=${spec.note}`);

  const reference = {
    desktop: resolveClientAssetPath(pack.stage.background.landscape),
    mobile: resolveClientAssetPath(pack.stage.background.portrait),
  };
  const outDir = defaultOutDir(env);
  const genStarted = performance.now();
  const genOne = async (device: "desktop" | "mobile"): Promise<string> => {
    const composed = composeScenePrompt(spec, pack, device);
    const result = await generateImage({
      baseUrl: config.providers.image.baseUrl,
      apiKey: config.providers.image.apiKey,
      model: config.providers.image.model,
      prompt: composed.prompt,
      media: { type: "photo", id: `smoke-scene-${device}` },
      size: composed.size,
      reference: { path: reference[device] },
      timeoutMs: IMAGE_TIMEOUT_MS,
      outDir,
      log: (event, detail) => info(`  · ${event} ${detail === undefined ? "" : JSON.stringify(detail)}`),
    });
    return result.url;
  };
  const [desktop, mobile] = await Promise.all([genOne("desktop"), genOne("mobile")]);
  const genMs = performance.now() - genStarted;

  // 参考图本地文件确认真实存在（不打印内容）。
  const refOk = (path: string): string => {
    try {
      const bytes = readFileSync(path).byteLength;
      return `${bytes} bytes`;
    } catch {
      return "缺失";
    }
  };
  info(`参考图：desktop ${refOk(reference.desktop)}，mobile ${refOk(reference.mobile)}`);
  info(`生图 OK（并行两张）：${Math.round(genMs)}ms`);
  info(`  desktop → ${desktop}`);
  info(`  mobile  → ${mobile}`);
  info(`总耗时（扩写 + 生图）：${Math.round(performance.now() - started)}ms`);

  // 把两次产出的路径记到临时文件，便于验收时查看（不含 Key）。
  const summaryPath = `${outDir}/smoke-scene-last.json`;
  try {
    writeFileSync(
      summaryPath,
      `${JSON.stringify({ characterId: pack.id, userText: USER_TEXT, label: spec.label, urls: { desktop, mobile }, writeMs: Math.round(writeMs), genMs: Math.round(genMs) }, null, 2)}\n`,
    );
    info(`结果写入 ${summaryPath}`);
  } catch {
    // 目录不可写时忽略（不影响冒烟结论）。
  }

  console.log("SMOKE:SCENE OK");
}

main().catch((error: unknown) => {
  console.error(`[smoke:scene] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
