import type { CallMetrics, FormatRequest } from "../types";
import { runA } from "./a";
import { runB } from "./b";
import { runE } from "./e";

export type FormatModule = {
  id: "a" | "b" | "e";
  label: string;
  /** 复杂度主观分（0-100）与理由，填在报告里。 */
  complexity: { score: number; reason: string };
  run: (request: FormatRequest) => Promise<CallMetrics>;
};

export const FORMATS: readonly FormatModule[] = [
  {
    id: "a",
    label: "a 逐行 JSON",
    complexity: {
      score: 90,
      reason:
        "每行独立 JSON.parse，解析器不到 40 行；不需要 SDK，也不需要处理不完整 JSON；唯一要注意的是行缓冲。",
    },
    run: runA,
  },
  {
    id: "b",
    label: "b AI SDK streamObject",
    complexity: {
      score: 50,
      reason:
        "要引入 ai + @ai-sdk/openai-compatible、把 LlmBeat 写成 JSON Schema、处理 partialObjectStream 的不完整元素；provider 在 supportsStructuredOutputs=false 时只发 json_object，schema 不下发，格式仍靠提示词；providerOptions 的键必须是 provider 名（实测踩坑：写错键导致思考未关闭，这一轮数据作废）。",
    },
    run: runB,
  },
  {
    id: "e",
    label: "e 行内标签",
    complexity: {
      score: 65,
      reason:
        "按句切分 + 正则剥标签，情绪标签要跨句继承；句号之后单独出现的 <act:…> 必须回填给上一句（实测必须加这段逻辑，否则纯标签片段会被算成空 beat）；say 里出现方括号或尖括号还需防御。",
    },
    run: runE,
  },
];
