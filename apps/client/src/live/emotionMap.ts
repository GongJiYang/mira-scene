/**
 * 协议情绪 → 忧奈 Live2D 情绪（S6b §3）。
 *
 * 忧奈模型只有四套参数组合（calm / guarded / sad / warm，S6a §1.3）；
 * 协议的 `neutral` 视同 `calm`，`surprised` 没有对应组合，用 `calm` 兜底。
 *
 * 纯函数，单独成文件：渲染外壳（`.tsx`）会引入 Cubism 别名，单测不便加载。
 */
import type { Emotion } from "@mira/protocol";
import type { YunaEmotion } from "../render/live2d/yunaParams";

export function toYunaEmotion(emotion: Emotion): YunaEmotion {
  switch (emotion) {
    case "calm":
    case "guarded":
    case "sad":
    case "warm":
    case "neutral":
      return emotion;
    case "surprised":
      return "calm";
  }
}
