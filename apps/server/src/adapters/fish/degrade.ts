/**
 * STT 降级装饰器（§3）：Fish 402/429 → 返回空串，走会话层现有的「没听清」兜底路径。
 *
 * 会话层本轮只允许改两处（架构关卡 §2），无法新增 STT 错误分支，因此把
 * 「Fish 额度/限流 → 空结果」这条降级放在适配器外层，保持会话层不变。
 * 其它错误原样抛出（仍走 turn_failed）。
 */
import type { Logger } from "../../log";
import type { STTPort } from "../../ports";
import { isFishApiError } from "./errors";

export function withSttErrorDegrade(stt: STTPort, options: { log?: Logger } = {}): STTPort {
  return {
    ...stt,
    async transcribe(audio, signal): Promise<string> {
      try {
        return await stt.transcribe(audio, signal);
      } catch (error) {
        if (isFishApiError(error) && (error.code === "fish_credit" || error.code === "fish_rate")) {
          options.log?.({
            ts: Date.now(),
            event: "provider_fallback",
            detail: { port: "stt", reason: error.code },
          });
          return "";
        }
        throw error;
      }
    },
  };
}
