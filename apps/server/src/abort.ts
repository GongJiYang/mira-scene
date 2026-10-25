/**
 * 取消信号工具：所有适配器与会话层共用的 AbortError 约定。
 * Node 环境的 lib 不含 DOM 类型，这里用带 name 的 Error 表达 AbortError。
 */
export function createAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError();
}

/** 可被 signal 提前打断的 sleep：中止时以 AbortError 结束。 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError());
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    reject(createAbortError());
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}
