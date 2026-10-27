/**
 * S6c §2：真实场景扩写（`SceneWriterPort` 的真实实现）。
 *
 * 复用现有 LLM 适配器（按 `LLM_PROVIDER`）：
 * - `deepseek`：走 DeepSeek 适配器（OpenAI 兼容流式）；
 * - `commandcode`：走 Command Code 适配器（`cmd -p`）。
 *
 * 提示词用 `characters/<id>/scene.v1.md`（同样的 STATIC/DYNAMIC 结构，用现有 loader）。
 * 输出一行 JSON（`parseSceneSpec` 校验）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { flattenMessages } from "../adapters/commandcode/flattenMessages";
import { parseCmdNdjson } from "../adapters/commandcode/parseCmdNdjson";
import type { Logger } from "../log";
import type { SceneWriterPort, SceneWriteContext } from "../ports";
import type { ChatMessage } from "../prompts/renderPrompt";

/** 加载 `characters/<id>/scene.v1.md`（与 pack.ts 的 readPromptFile 同规则）。 */
function loadScenePrompt(dir: string): { version: string; staticText: string; dynamicTemplate: string } {
  const path = join(dir, "scene.v1.md");
  const text = readFileSync(path, "utf8");
  const version = /<!--\s*prompt:\s*([^\s·]+)/.exec(text)?.[1] ?? "unknown";
  const staticMatch = /^## STATIC\b.*$/m.exec(text);
  const dynamicMatch = /^## DYNAMIC\b.*$/m.exec(text);
  if (!staticMatch || !dynamicMatch) {
    throw new Error(`场景扩写提示词缺少 ## STATIC / ## DYNAMIC 段落：${path}`);
  }
  return {
    version,
    staticText: text.slice(staticMatch.index + staticMatch[0].length, dynamicMatch.index).trim(),
    dynamicTemplate: text.slice(dynamicMatch.index + dynamicMatch[0].length).trim(),
  };
}

/** 渲染场景扩写提示词（STATIC 作为 system，DYNAMIC 填充后作为 user）。 */
function renderSceneMessages(ctx: SceneWriteContext): ChatMessage[] {
  const template = loadScenePrompt(ctx.pack.dir);
  const filled = template.dynamicTemplate
    .replace(/\{\{node_label\}\}/g, ctx.nodeLabel)
    .replace(/\{\{current_scene\}\}/g, ctx.currentScene)
    .replace(/\{\{user_text\}\}/g, ctx.userText.replace(/[<>]/g, ""));
  return [
    { role: "system", content: template.staticText },
    { role: "user", content: filled },
  ];
}

/** 创建真实场景扩写端口（按 provider 选适配器）。 */
export function createSceneWriter(options: {
  provider: "deepseek" | "commandcode";
  deepseek?: { baseUrl: string; apiKey: string; model: string };
  commandcode?: { model?: string };
  log?: Logger;
}): SceneWriterPort {
  const log = options.log;

  if (options.provider === "commandcode") {
    const model = options.commandcode?.model ?? "deepseek/deepseek-v4-flash";
    return {
      async write(ctx, signal) {
        const messages = renderSceneMessages(ctx);
        const prompt = flattenMessages(messages);
        const template = loadScenePrompt(ctx.pack.dir);
        log?.({ ts: Date.now(), event: "scene_prompt_version", detail: { version: template.version } });

        const cwd = await mkdtemp(join(tmpdir(), "mira-scene-cmd-"));
        let child: ReturnType<typeof nodeSpawn>;
        try {
          child = nodeSpawn("cmd", ["-p", prompt, "-m", model, "--effort", "off", "--skip-onboarding", "--trust", "--no-session", "--no-skills", "--max-turns", "1", "--output-format", "json"], {
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
        const decoder = new TextDecoder();
        try {
          if (child.stdout) {
            for await (const chunk of child.stdout) {
              if (signal.aborted) break;
              const chunkText = decoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, { stream: true });
              const result = parseCmdNdjson(chunkText, cmdCarry);
              cmdCarry = result.carry;
              if (result.error !== null) throw new Error(`cmd 返回错误：${result.error}`);
              text += result.text;
            }
          }
          if (!signal.aborted) {
            const flushed = parseCmdNdjson("\n", cmdCarry);
            text += flushed.text;
          }
          const exit = await exited.promise;
          if (exit.errored) throw exit.errored;
          if (exit.code !== 0) throw new Error(`cmd 进程以非零退出码结束：${exit.code ?? "unknown"}`);
          return text.trim();
        } finally {
          signal.removeEventListener("abort", onAbort);
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
      const messages = renderSceneMessages(ctx);
      const template = loadScenePrompt(ctx.pack.dir);
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
