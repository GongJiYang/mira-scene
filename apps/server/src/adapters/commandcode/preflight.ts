/**
 * `LLM_PROVIDER=commandcode` 的启动契约检查（S6a §2）。
 *
 * 启动时（非 mock）检查 `cmd` 可执行且 `cmd status` 显示已登录；不满足就启动报错退出，
 * 给出清楚的提示。不做任何降级（D37 / §2）。
 *
 * `spawn` 可注入，便于单测。
 */
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { isCommandCodeAuthed } from "./status";

export type PreflightSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export type PreflightOptions = {
  command?: string;
  spawn?: PreflightSpawn;
  /** 超时（毫秒），默认 10s。 */
  timeoutMs?: number;
};

/**
 * 检查 commandcode 可用性：
 * 1. `cmd --version` 能跑（可执行）；
 * 2. `cmd status` 输出里显示已登录。
 * 失败抛带清楚提示的 Error（启动即报错）。
 */
export async function assertCommandCodeReady(options: PreflightOptions = {}): Promise<void> {
  const command = options.command ?? "cmd";
  const spawn = options.spawn ?? (nodeSpawn as unknown as PreflightSpawn);
  const timeoutMs = options.timeoutMs ?? 10_000;

  const version = await runCapture(spawn, command, ["--version"], timeoutMs);
  if (version.error !== null) {
    throw new Error(`未找到可执行的 \`${command}\`：${version.error.message}（LLM_PROVIDER=commandcode 需要它）`);
  }
  if (version.code !== 0) {
    throw new Error(`\`${command} --version\` 退出码 ${version.code}：${version.stderr.trim().slice(0, 200)}`);
  }

  const status = await runCapture(spawn, command, ["status"], timeoutMs);
  if (status.error !== null) {
    throw new Error(`\`${command} status\` 执行失败：${status.error.message}`);
  }
  if (status.code !== 0) {
    throw new Error(`\`${command} status\` 退出码 ${status.code}：${status.stderr.trim().slice(0, 200)}`);
  }
  if (!isCommandCodeAuthed(`${status.stdout}\n${status.stderr}`)) {
    throw new Error(
      `\`${command}\` 未登录：请先运行 \`${command}\` 完成登录，再以 LLM_PROVIDER=commandcode 启动。`,
    );
  }
}

type CaptureResult = { code: number | null; stdout: string; stderr: string; error: Error | null };

function runCapture(
  spawn: PreflightSpawn,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CaptureResult> {
  const { promise, resolve } = Promise.withResolvers<CaptureResult>();
  let stdout = "";
  let stderr = "";
  let settled = false;

  const finish = (result: CaptureResult): void => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  let child: ReturnType<PreflightSpawn>;
  try {
    child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return Promise.resolve({ code: null, stdout, stderr, error: error instanceof Error ? error : new Error(String(error)) });
  }

  child.once("error", (error) => finish({ code: null, stdout, stderr, error }));
  child.once("close", (code) => finish({ code, stdout, stderr, error: null }));

  child.stdout?.on?.("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr?.on?.("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const timer = setTimeout(() => {
    finish({ code: null, stdout, stderr, error: new Error(`\`${command} ${args.join(" ")}\` 超时 ${timeoutMs}ms`) });
  }, timeoutMs);
  void promise.finally(() => clearTimeout(timer));

  return promise;
}
