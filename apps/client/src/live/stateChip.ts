/**
 * S6u §2/§3：舞台右上角状态牌（纯函数，关卡 3）。
 *
 * 读现有 `phase`，映射到「色系 tone + 文案」：视图只负责渲染，映射逻辑可单测。
 * 文案来自 `uiText.ts`（铁律 4）。
 */
import type { StagePhase } from "../view/useStageViewModel";
import { UI_TEXT } from "./uiText";

/** 状态牌色系（对应 Tokens：待机灰点 / 倾听蓝 / 思考琥珀 / 说话淡紫）。 */
export type ChipTone = "idle" | "listen" | "think" | "speak";

export type StateChipView = {
  tone: ChipTone;
  label: string;
};

/**
 * `phase` → 状态牌视图。
 * `idle` 用灰点；`listening` 蓝描边 + 耳朵图标；`thinking` 琥珀三点；`speaking` 淡紫声波柱。
 * `error` 无对应态，回落到待机（`idle`）——错误信息由 `.live-error`（debug）单独承载。
 */
export function stateChipFor(phase: StagePhase): StateChipView {
  switch (phase) {
    case "listening":
      return { tone: "listen", label: UI_TEXT.chipListening };
    case "thinking":
      return { tone: "think", label: UI_TEXT.chipThinking };
    case "speaking":
      return { tone: "speak", label: UI_TEXT.chipSpeaking };
    case "idle":
    case "error":
    default:
      return { tone: "idle", label: UI_TEXT.chipIdle };
  }
}
