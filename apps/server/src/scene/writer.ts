/**
 * S6c §2：真实场景扩写（`SceneWriterPort` 的真实实现）。
 *
 * 复用现有 LLM 适配器（按 `LLM_PROVIDER`）：
 * - `deepseek`：走 DeepSeek 适配器（OpenAI 兼容流式）；
 * - `commandcode`：走 Command Code 的子进程实现（`cmd -p`，复用 `adapters/commandcode` 的
 *   `flattenMessages` + `parseCmdNdjson`）。
 *
 * 提示词用 `characters/<id>/scene.v1.md`（同样的 STATIC/DYNAMIC 结构，复用 `prompts/loader.ts`
 * 的 `parsePromptFile`）。输出一行 JSON（`parseSceneSpec` 校验）。
 *
 * S6c-fix1 §6：
 * - 把用户文字代入模板一律用**函数替换**（`() => text`），避免 `$'`、`$&`、`$$` 被展开；
 * - 复用 `parsePromptFile`，删掉重复的提示词解析实现；提示词文件每次调用只读一次；
 * - commandcode 分支出错时结束子进程。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parsePromptFile } from "../prompts/loader";
import { flattenMessages } from "../adapters/commandcode/flattenMessages";
import { parseCmdNdjson } from "../adapters/commandcode/parseCmdNdjson";
import type { SpawnFn } from "../adapters/commandcode/commandCodeLlm";
import type { Logger } from "../log";
import type { SceneWriterPort, SceneWriteContext } from "../ports";
import type { ChatMessage } from "../prompts/renderPrompt";

type ScenePrompt = { version: string; staticText: string; dynamicTemplate: string };

/** 加载 `characters/<id>/scene.v1.md`（复用 `prompts/loader.ts` 的解析规则）。 */
function loadScenePrompt(dir: string): ScenePrompt {
  const path = join(dir, "scene.v1.md");
  return parsePromptFile(readFileSync(path, "utf8"), path);
}

/** 用函数替换填充模板，避免用户输入里的 `$'`、`$&`、`$$` 被展开。 */
function fillSceneTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (whole, key: string) => values[key] ?? whole);
}

/** 渲染场景扩写提示词（STATIC 作为 system，DYNAMIC 填充后作为 user）。 */
function renderSceneMessages(ctx: SceneWriteContext, template: ScenePrompt): ChatMessage[] {
  const filled = fillSceneTemplate(template.dynamicTemplate, {
    node_label: ctx.nodeLabel,
    current_scene: ctx.currentScene,
    user_text: ctx.userText.replace(/[<>]/g, ""),
  });
  return [
    { role: "system", content: template.staticText },
    { role: "user", content: filled },
  ];
}

/** S6c-fix1 §6 单测用：暴露渲染以验证代入模板的函数替换语义。 */
export function renderSceneMessagesForTest(ctx: SceneWriteContext): ChatMessage[] {
  return renderSceneMessages(ctx, loadScenePrompt(ctx.pack.dir));
}

export type SceneWriterOptions = {
  provider: "deepseek" | "commandcode";
  deepseek?: { baseUrl: string; apiKey: string; model: string };
  commandcode?: { model?: string };
  /** 注入的 spawn（单测用）；缺省用 `node:child_process`。 */
  spawn?: SpawnFn;
  log?: Logger;
};

/** 创建真实场景扩写端口（按 provider 选适配器）。 */
export function createSceneWriter(options: SceneWriterOptions): SceneWriterPort {
  const log = options.log;

  if (options.provider === "commandcode") {
    const model = options.commandcode?.model ?? "deepseek/deepseek-v4-flash";
    const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
    return {
      async write(ctx, signal) {
        const template = loadScenePrompt(ctx.pack.dir);
        const prompt = flattenMessages(renderSceneMessages(ctx, template));
        log?.({ ts: Date.now(), event: "scene_prompt_version", detail: { version: template.version } });

        const cwd = await mkdtemp(join(tmpdir(), "mira-scene-cmd-"));
        let child;
        try {
          child = spawn("cmd", ["-p", prompt, "-m", model, "--effort", "off", "--skip-onboarding", "--trust", "--no-session", "--no-skills", "--max-turns", "1", "--output-format", "json"], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (error) {
          await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        child.stdin?.end();

        const exited = Promise.withResolvers<{ code: number | null; errored: Error | null }>();
        child.once("error", (error) => exited.resolve({ code: null, errored: error }));
        child.once("close", (code) => exited.resolve({ code, errored: null }));

        const onAbort = (): void => {
          child.kill("SIGTERM");
        };
        if (signal.aborted) onAbort();
        signal.addEventListener("abort", onAbort, { once: true });

        let cmdCarry = "";
        let text = "";
        let cmdError: string | null = null;
        const decoder = new TextDecoder();
        try {
          if (child.stdout) {
            for await (const chunk of child.stdout) {
              if (signal.aborted) break;
              const chunkText = decoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, { stream: true });
              const result = parseCmdNdjson(chunkText, cmdCarry);
              cmdCarry = result.carry;
              if (result.error !== null && cmdError === null) cmdError = result.error;
              text += result.text;
            }
          }
          if (!signal.aborted) {
            const flushed = parseCmdNdjson("\n", cmdCarry);
            if (flushed.error !== null && cmdError === null) cmdError = flushed.error;
            text += flushed.text;
          }
          // S6c-fix1 §6：出错时必须结束子进程（非 abort 也可能挂着）。
          if (signal.aborted || cmdError !== null) child.kill("SIGTERM");
          const exit = await exited.promise;
          if (exit.errored) throw exit.errored;
          if (cmdError !== null) throw new Error(`cmd 返回错误：${cmdError}`);
          if (exit.code !== 0) throw new Error(`cmd 进程以非零退出码结束：${exit.code ?? "unknown"}`);
          return text.trim();
        } finally {
          signal.removeEventListener("abort", onAbort);
          // 兜底：任何异常路径都结束子进程，避免泄漏。
          child.kill("SIGTERM");
          await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    };
  }

  // deepseek
  const deepseek = options.deepseek;
  if (!deepseek) throw new Error("deepseek 凭据缺失");
  return {
    async write(ctx, signal) {
      const template = loadScenePrompt(ctx.pack.dir);
      const messages = renderSceneMessages(ctx, template);
      log?.({ ts: Date.now(), event: "scene_prompt_version", detail: { version: template.version } });

      const response = await fetch(`${deepseek.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deepseek.apiKey}`,
        },
        body: JSON.stringify({
          model: deepseek.model,
          messages,
          stream: false,
          thinking: { type: "disabled" },
          temperature: 0.7,
          max_tokens: 300,
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`DeepSeek 返回 ${response.status} ${detail.slice(0, 200)}`);
      }
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("DeepSeek 返回缺少 content");
      return content.trim();
    },
  };
}
