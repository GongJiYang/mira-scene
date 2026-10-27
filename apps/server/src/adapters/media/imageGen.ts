/**
 * S6b §5.5：真实生图媒体适配器（实现现有 `MediaPort`）。
 *
 * OpenAI 兼容接口：`POST {baseUrl}/images/generations`（baseUrl 已统一成 `…/v1`），
 * `model` 默认 `gpt-image-2.5-sunburst`（`IMAGE_MODEL` 覆盖），取返回 `data[0].b64_json`，
 * 解码后写入**客户端静态目录** `apps/client/public/generated/<id>.png`，返回可访问 URL。
 *
 * Key 只从 `IMAGE_API_KEY`（经 config.providers.image）读取，绝不打印。
 * `IMAGE_API_KEY` 未配置时不应创建本适配器（由 index.ts 用 presetMedia；那是配置选择，非降级）。
 * 测试注入假 fetch，不发真实请求。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Media } from "@mira/protocol";
import { createAbortError, isAbortError, throwIfAborted } from "../../abort";
import type { MediaContext, MediaPort, PresetMediaResult } from "../../ports";
import { buildImagePrompt } from "./imagePrompt";

export type ImageGenOptions = {
  /** 已统一成 `…/v1` 的根地址。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 生图提示词（由 buildImagePrompt 组装好的完整字符串）。 */
  prompt: string;
  /** 图片标识（也是输出文件名 `<id>.png`）。 */
  media: Media;
  /** 请求超时（毫秒），默认 60_000（实测单张 23–31 秒）。 */
  timeoutMs?: number;
  /** 输出目录（默认客户端 public/generated）。 */
  outDir?: string;
  /** 注入的 fetch（测试用假实现）。 */
  fetchImpl?: typeof fetch;
  /** S6b-fix1 §4：外层中止信号（会话解绑/关闭时中止进行中的生图请求）。内部 60 秒超时仍独立生效。 */
  signal?: AbortSignal;
  log?: (event: string, detail?: unknown) => void;
  /**
   * S6c §4：参考图（当前背景）。有参考图时走 `POST {baseUrl}/v1/images/edits`（multipart），
   * 否则走 generations。参考图只用于相机与构图，内容由提示词决定。
   */
  reference?: { path: string };
  /** S6c §3：生图尺寸（desktop 1536×1024 / mobile 1024×1536）。 */
  size?: "1536x1024" | "1024x1536";
};

export const DEFAULT_IMAGE_TIMEOUT_MS = 60_000;

/** S6b-fix1 §5：服务端数据目录（仓库根 `var/generated/`），可用 `GENERATED_DIR` 覆盖。 */
export function defaultOutDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GENERATED_DIR?.trim();
  if (override) return override;
  return join(findRepoRoot(dirname(fileURLToPath(import.meta.url))), "var", "generated");
}

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("找不到仓库根目录（pnpm-workspace.yaml）");
    dir = parent;
  }
}

type ImagesResponse = { data?: Array<{ b64_json?: string }> };

/**
 * 调一次生图接口并把结果落盘。成功返回 `{ url, status: "ready" }`；
 * HTTP 错误 / 超时 / 中止按契约抛出（调用方决定降级）。
 * S6c §4：有参考图时走 `/v1/images/edits`（multipart：`model`、`prompt`、`size`、`image`）。
 */
export async function generateImage(options: ImageGenOptions): Promise<PresetMediaResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
  const outDir = options.outDir ?? defaultOutDir();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  // S6b-fix1 §4：把外层 signal 接到 fetch 上（会话解绑/关闭时中止生图请求）；内部 60 秒超时仍独立生效。
  const outer = options.signal;
  const onOuterAbort = (): void => controller.abort();
  if (outer !== undefined) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  // 任一信号中止都会触发 fetch 中止。
  const fetchSignal = outer !== undefined ? AbortSignal.any([controller.signal, outer]) : controller.signal;
  try {
    let response: Response;
    if (options.reference !== undefined) {
      // S6c §4：参考图走 /v1/images/edits（multipart）。
      const { readFileSync } = await import("node:fs");
      const imageBuffer = readFileSync(options.reference.path);
      const form = new FormData();
      form.append("model", options.model);
      form.append("prompt", options.prompt);
      form.append("size", options.size ?? "1536x1024");
      form.append("image", new Blob([imageBuffer]), "reference.png");
      response = await fetchImpl(`${options.baseUrl}/images/edits`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: form,
        signal: fetchSignal,
      });
    } else {
      response = await fetchImpl(`${options.baseUrl}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model: options.model, prompt: options.prompt, n: 1, size: options.size ?? "1536x1024" }),
        signal: fetchSignal,
      });
    }
    if (!response.ok) {
      throw new Error(`生图接口 HTTP ${response.status}`);
    }
    const body = (await response.json()) as ImagesResponse;
    const b64 = body.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || b64 === "") {
      throw new Error("生图接口返回缺少 b64_json");
    }
    mkdirSync(outDir, { recursive: true });
    const file = `${options.media.id}.png`;
    writeFileSync(join(outDir, file), Buffer.from(b64, "base64"));
    options.log?.("image_gen_ready", { file });
    return { url: `/generated/${file}`, status: "ready" };
  } catch (error) {
    if (isAbortError(error)) throw createAbortError();
    throw error;
  } finally {
    clearTimeout(timer);
    if (outer !== undefined) outer.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * `MediaPort` 形态的生图适配器：把 `preset(media, ctx)` 映射到一次 `generateImage`。
 * S6b-fix1 §4：提示词由 `buildImagePrompt(ctx.pack, ctx.history)` 组装（用到本轮之前的对话）。
 */
export function createImageGenMedia(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  outDir?: string;
  fetchImpl?: typeof fetch;
  log?: (event: string, detail?: unknown) => void;
}): MediaPort {
  return {
    async preset(media: Media, ctx: MediaContext, signal: AbortSignal): Promise<PresetMediaResult> {
      throwIfAborted(signal);
      const result = await generateImage({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
        prompt: buildImagePrompt(ctx.pack, ctx.history),
        media,
        timeoutMs: options.timeoutMs,
        outDir: options.outDir,
        fetchImpl: options.fetchImpl,
        signal,
        log: options.log,
      });
      throwIfAborted(signal);
      return result;
    },
  };
}
