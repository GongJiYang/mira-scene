/**
 * Command Code LLM 适配器（S6a §2）。
 *
 * 背景（D39）：DeepSeek 余额为 0，改用 Command Code 的额度。`cmd -p … --output-format json`
 * 输出 NDJSON，回复文字在 `{"type":"event","event":{"type":"text_delta","delta":"…"}}`，
 * 最后一行 `{"type":"result","subtype":"success",…}`。
 *
 * - 实现现有 `LLMPort`（`streamBeats`），核心和会话层一行不改。
 * - 纯函数 `flattenMessages` 把 chat 消息拼成一条 prompt；`parseCmdNdjson` 增量解析文本。
 * - 文本再交给现有 `parseBeatLines` 产出 beat，与 DeepSeek 适配器同一路径。
 * - `spawn` 可注入（默认 `node:child_process`），便于单测。
 * - AbortSignal：立刻 kill 子进程，迭代器立即结束（与 DeepSeek 适配器的中止语义一致）。
 */
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAbortError } from "../../abort";
import type { Logger } from "../../log";
import type { LLMContext, LLMPort } from "../../ports";
import { renderPrompt, type ChatMessage } from "../../prompts/renderPrompt";
import type { PromptTemplate } from "../../prompts/loader";
import { parseBeatLines } from "../deepseek/parseBeatLines";
import { flattenMessages } from "./flattenMessages";
import { parseCmdNdjson } from "./parseCmdNdjson";

export const DEFAULT_COMMANDCODE_MODEL = "deepseek/deepseek-v4-flash";

/** `cmd` 固定参数（S6a §2）。`-p <prompt>` 与 `-m <model>` 由适配器插入。 */
export const CMD_ARGS = [
  "--effort",
  "off",
  "--skip-onboarding",
  "--trust",
  "--no-session",
  "--no-skills",
  "--max-turns",
  "1",
  "--output-format",
  "json",
] as const;

/** 注入用的最小 spawn 签名（与 `node:child_process.spawn` 兼容）。 */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnLike;

/** 子进程在本适配器里用到的能力子集。 */
export type SpawnLike = {
  stdout: AsyncIterable<Buffer | string> | null;
  stderr: AsyncIterable<Buffer | string> | null;
  stdin: { end(): void } | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type CommandCodeLlmOptions = {
  model?: string;
  prompt: PromptTemplate;
  spawn?: SpawnFn;
  log?: Logger;
  /** `cmd` 二进制名，默认 `cmd`。 */
  command?: string;
  /** 工作目录提供者，默认用一个空的临时目录（不要让它读到仓库）。 */
  makeCwd?: () => Promise<string>;
  /** 结束后是否清理临时目录，默认清理。 */
  cleanupCwd?: boolean;
};

function defaultMakeCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mira-cmd-"));
}

export function createCommandCodeLlm(options: CommandCodeLlmOptions): LLMPort {
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const command = options.command ?? "cmd";
  const model = options.model ?? DEFAULT_COMMANDCODE_MODEL;
  const makeCwd = options.makeCwd ?? defaultMakeCwd;
  const cleanupCwd = options.cleanupCwd ?? true;

  return {
    async *streamBeats(ctx: LLMContext, signal): AsyncIterable<unknown> {
      const messages: ChatMessage[] = renderPrompt(options.prompt.staticText, options.prompt.dynamicTemplate, ctx);
      const prompt = flattenMessages(messages);

      options.log?.({ ts: Date.now(), event: "prompt_version", detail: { prompt_version: options.prompt.version } });

      const startedMs = Date.now();
      const cwd = await makeCwd();
      let child: SpawnLike;
      try {
        child = spawn(command, ["-p", prompt, "-m", model, ...CMD_ARGS], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        if (cleanupCwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }

      // stdin 关闭：不让它等待交互输入。
      child.stdin?.end();

      // 子进程退出码：error 与 close 都收敛到一个 promise（取先到者）。
      const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null; errored: Error | null }>();
      child.once("error", (error) => exited.resolve({ code: null, signal: null, errored: error }));
      child.once("close", (code, exitSignal) => exited.resolve({ code, signal: exitSignal, errored: null }));

      // 中止：立刻 kill 子进程。
      const onAbort = (): void => {
        child.kill("SIGTERM");
      };
      if (signal.aborted) onAbort();
      signal.addEventListener("abort", onAbort, { once: true });

      const decoder = new TextDecoder();
      // 两级缓冲：cmdCarry 是 NDJSON 的行缓冲，beatCarry 是 parseBeatLines 的尾巴。
      let cmdCarry = "";
      let beatCarry = "";
      let cmdError: string | null = null;
      let sawResult = false;

      const emitText = function* (text: string): Generator<unknown> {
        const parsed = parseBeatLines(text, beatCarry);
        beatCarry = parsed.carry;
        for (const warning of parsed.warnings) {
          options.log?.({ ts: Date.now(), event: "llm_beat_warning", detail: { warning } });
        }
        yield* parsed.beats;
      };

      const consume = function* (chunk: string): Generator<unknown> {
        const result = parseCmdNdjson(chunk, cmdCarry);
        cmdCarry = result.carry;
        if (result.usage !== null) {
          options.log?.({
            ts: Date.now(),
            event: "llm_usage",
            detail: { ...result.usage, duration_ms: Date.now() - startedMs },
          });
        }
        if (result.error !== null && cmdError === null) cmdError = result.error;
        if (result.done) sawResult = true;
        if (result.text !== "") yield* emitText(result.text);
      };

      try {
        if (child.stdout !== null) {
          for await (const chunk of child.stdout as AsyncIterable<Buffer | string>) {
            if (signal.aborted) break;
            const text = decoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, { stream: true });
            yield* consume(text);
          }
        }

        if (!signal.aborted) {
          // 冲掉 NDJSON 与 beat 两侧的最后一行。
          yield* consume("\n");
          yield* consume("");
          const tail = parseBeatLines("\n", beatCarry);
          beatCarry = tail.carry;
          for (const warning of tail.warnings) {
            options.log?.({ ts: Date.now(), event: "llm_beat_warning", detail: { warning } });
          }
          yield* tail.beats;
        }

        if (signal.aborted) return;

        const exit = await exited.promise;
        if (exit.errored !== null) throw exit.errored;
        if (cmdError !== null) throw new Error(`cmd 返回错误：${cmdError}`);
        if (exit.code !== 0) {
          throw new Error(`cmd 进程以非零退出码结束：${exit.code ?? exit.signal ?? "unknown"}`);
        }
        if (!sawResult) throw new Error("cmd 未返回 result 行");
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        throw error;
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (cleanupCwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
