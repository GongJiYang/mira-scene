import { describe, expect, it } from "vitest";
import { stateChipFor } from "../src/live/stateChip";
import { UI_TEXT } from "../src/live/uiText";

/**
 * S6u §2/§3：状态牌映射（关卡 3：phase → 文案 / 样式写成纯函数并单测）。
 */

describe("stateChipFor：四态 + error 兜底", () => {
  it("idle → 发呆中（灰点）", () => {
    expect(stateChipFor("idle")).toEqual({ tone: "idle", label: UI_TEXT.chipIdle });
  });

  it("listening → 在听你说（蓝）", () => {
    expect(stateChipFor("listening")).toEqual({ tone: "listen", label: UI_TEXT.chipListening });
  });

  it("thinking → 想一想（琥珀）", () => {
    expect(stateChipFor("thinking")).toEqual({ tone: "think", label: UI_TEXT.chipThinking });
  });

  it("speaking → 说话中（淡紫）", () => {
    expect(stateChipFor("speaking")).toEqual({ tone: "speak", label: UI_TEXT.chipSpeaking });
  });

  it("error → 回落待机（无独立态）", () => {
    expect(stateChipFor("error")).toEqual({ tone: "idle", label: UI_TEXT.chipIdle });
  });
});
