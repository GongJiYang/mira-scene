import type { LlmBeat } from "@mira/protocol";
import type { ProbeConfig } from "../shared/env";
import type { SceneState } from "./persona";
import type { BeatUnit } from "./beat";

export type FormatId = "a" | "b" | "e";

export type ProbeInput = {
  id: string;
  type: string;
  text: string;
};

export type CacheInfo = {
  hitTokens: number | null;
  missTokens: number | null;
  cachedTokens: number | null;
};

export type CallMetrics = {
  format: FormatId;
  inputId: string;
  inputType: string;
  /** 首个合法 beat 的到达时间；null = 整轮没有合法 beat。 */
  firstValidBeatMs: number | null;
  /** 首个被解析出的单元（不论是否合法）的到达时间。 */
  firstUnitMs: number | null;
  totalMs: number;
  /** 解析出的单元数（a = 行，e = 句，b = 数组元素）。 */
  units: number;
  /** 不经宽松修正即可解析的单元数。 */
  strictValidUnits: number;
  /** 枚举值合法的单元数。 */
  enumValidUnits: number;
  firstSayLen: number | null;
  firstSayWithin20: boolean | null;
  cache: CacheInfo;
  usageRaw: unknown;
  aborted: boolean;
  /** 取消请求到流真正结束的毫秒数（仅取消测试）。 */
  abortToCloseMs: number | null;
  httpStatus: number | null;
  error: string | null;
  rawText: string;
  rawSamples: string[];
  beats: LlmBeat[];
};

export type FormatRequest = {
  input: ProbeInput;
  scene: SceneState;
  config: ProbeConfig;
  abortAfterFirstBeat: boolean;
  /** 收到第一个合法 beat 时回调（runner 用来记录时间点）。 */
  onFirstBeat?: () => void;
};

export type StreamOutcome = {
  text: string;
  usage: Record<string, unknown> | null;
  aborted: boolean;
  abortToCloseMs: number | null;
  httpStatus: number | null;
  error: string | null;
};

export type UnitSink = {
  units: BeatUnit[];
  firstValidAtMs: number | null;
  push: (unit: BeatUnit) => void;
};

/** 收集单元并记录首个合法 beat 的时间点；首个合法 beat 后按请求 abort。 */
export function createSink(abort: () => void, request: FormatRequest): UnitSink {
  const sink: UnitSink = {
    units: [],
    firstValidAtMs: null,
    push(unit) {
      sink.units.push(unit);
      if (sink.firstValidAtMs === null && unit.strictValid) {
        sink.firstValidAtMs = unit.atMs;
        request.onFirstBeat?.();
        if (request.abortAfterFirstBeat) abort();
      }
    },
  };
  return sink;
}
