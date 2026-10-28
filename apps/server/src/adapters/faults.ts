/**
 * S5 故障注入（Q11 / D9）：用装饰器包装端口，开关来自 hello 的 `faults` 或环境变量 FAULTS。
 * 所有装饰后的方法都原样透传 AbortSignal，不改变现有取消语义。
 */
import { createAbortError, sleep, throwIfAborted } from "../abort";
import type { LLMPort, STTPort, TTSPort } from "../ports";

export const FAULT_VALUES = [
  "llm_timeout",
  "llm_error",
  "tts",
  "tts_once",
  "stt",
  "stt_error",
  "slow",
  "ws_drop",
] as const;

export type Fault = (typeof FAULT_VALUES)[number];

/** 端口类别；`media` 为 S5 预留（尚无媒体端口实现，暂不注入故障）。 */
export type PortKind = "stt" | "llm" | "tts" | "media";

/** `slow`：每次端口调用前额外等待的时长。 */
export const SLOW_DELAY_MS = 1_500;
/** `ws_drop`：本轮第几个 beat 发出后关闭连接。 */
export const WS_DROP_AFTER_BEAT = 2;
/** LLM 首 token 超时默认值（D10）。 */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 10_000;
export const FIRST_TOKEN_TIMEOUT_ENV = "LLM_FIRST_TOKEN_TIMEOUT_MS";

export function isFault(value: string): value is Fault {
  return (FAULT_VALUES as readonly string[]).includes(value);
}

/** 逗号分隔的字符串（环境变量 FAULTS）或 hello 里的数组 → 去重后的已知故障。 */
export function parseFaults(raw: string | readonly string[] | undefined | null): Fault[] {
  const list = typeof raw === "string" ? raw.split(",") : (raw ?? []);
  const faults = new Set<Fault>();
  for (const item of list) {
    const value = typeof item === "string" ? item.trim() : "";
    if (isFault(value)) faults.add(value);
  }
  return [...faults];
}

/**
 * freeze-fix2 §2：是否恢复已有会话。
 * 只有「已有会话的故障」与「本次 hello 请求的故障」按集合相等（与顺序、重复无关）才恢复；
 * 不相等 → 按新会话处理（让请求的 faults 生效，且不把旧会话的 faults 混进来）。
 */
export function shouldResume(existing: readonly Fault[], requested: readonly Fault[]): boolean {
  const a = new Set(existing);
  const b = new Set(requested);
  if (a.size !== b.size) return false;
  for (const fault of a) if (!b.has(fault)) return false;
  return true;
}

/** LLM 首 token 超时（毫秒）；非法值直接抛错，不静默降级。 */
export function readFirstTokenTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FIRST_TOKEN_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
  if (!/^\d+$/.test(raw)) throw new Error(`非法的 ${FIRST_TOKEN_TIMEOUT_ENV}="${raw}"`);
  const value = Number.parseInt(raw, 10);
  if (value <= 0) throw new Error(`非法的 ${FIRST_TOKEN_TIMEOUT_ENV}="${raw}"`);
  return value;
}

/** 一直挂起到 signal 被中止：`llm_timeout` 用「永不产出」模拟首 token 卡死。 */
function hangUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError());
  const { promise, reject } = Promise.withResolvers<void>();
  signal.addEventListener("abort", () => reject(createAbortError()), { once: true });
  return promise;
}

export function withFaults(port: STTPort, kind: "stt", faults: readonly string[]): STTPort;
export function withFaults(port: LLMPort, kind: "llm", faults: readonly string[]): LLMPort;
export function withFaults(port: TTSPort, kind: "tts", faults: readonly string[]): TTSPort;
export function withFaults<P extends object>(port: P, kind: PortKind, faults: readonly string[]): P;
export function withFaults(port: object, kind: PortKind, faults: readonly string[]): object {
  const active = new Set(faults);
  const slow = active.has("slow");

  if (kind === "stt") {
    const stt = port as STTPort;
    return {
      ...stt,
      async transcribe(audio, signal) {
        throwIfAborted(signal);
        if (slow) await sleep(SLOW_DELAY_MS, signal);
        // S6b §2：`stt_error` 模拟 STT 抛错（网络 / 超时 / 5xx），走角色化的 stt_failed 兜底。
        if (active.has("stt_error")) throw new Error("fault:stt_error");
        if (active.has("stt")) return "";
        return stt.transcribe(audio, signal);
      },
    } satisfies STTPort;
  }

  if (kind === "llm") {
    const llm = port as LLMPort;
    return {
      ...llm,
      async *streamBeats(ctx, signal) {
        throwIfAborted(signal);
        if (slow) await sleep(SLOW_DELAY_MS, signal);
        if (active.has("llm_error")) throw new Error("fault:llm_error");
        if (active.has("llm_timeout")) {
          await hangUntilAborted(signal);
          return;
        }
        yield* llm.streamBeats(ctx, signal);
      },
    } satisfies LLMPort;
  }

  if (kind === "tts") {
    const tts = port as TTSPort;
    let calls = 0;
    return {
      ...tts,
      async synthesize(text, opts, signal) {
        const call = calls;
        calls += 1;
        throwIfAborted(signal);
        if (slow) await sleep(SLOW_DELAY_MS, signal);
        // `tts_once` 只让第一句（含重试后的第二次调用之前的首次）失败。
        if (active.has("tts") || (active.has("tts_once") && call === 0)) {
          throw new Error("fault:tts");
        }
        return tts.synthesize(text, opts, signal);
      },
    } satisfies TTSPort;
  }

  // media：预留；当前没有媒体端口，按原样返回。
  return port;
}
