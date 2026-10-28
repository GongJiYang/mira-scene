import { describe, expect, it } from "vitest";
import { composeBeats } from "../src/adapters/mock/mockLlm";
import { createInitialScene } from "../src/story";
import { testPack } from "./helpers/pack";

/**
 * freeze-fix3 §3/§4：Mock 在「nudge 轮 + 有未就绪照片」时，从 content.json 的
 * `photoWaitingLines` 按次序取一句（循环）。
 */
describe("Mock：截图未就绪的铺垫台词（§3）", () => {
  const pack = testPack("yuna");
  const scene = createInitialScene();

  it("nudge + 有未就绪照片：说 photoWaitingLines 里的一句", () => {
    const beats = composeBeats(
      { history: [], scene, userText: "（客人安静地坐着，没有说话）", pack, nudge: true, photoWaiting: true },
      pack,
    );
    const spoken = beats.filter((beat) => beat.say !== "").map((beat) => beat.say);
    expect(spoken).toHaveLength(1);
    expect(pack.photoWaitingLines).toContain(spoken[0]);
  });

  it("nudge 无未就绪照片：回退到节点 hook（不是 photoWaitingLines）", () => {
    const beats = composeBeats(
      { history: [], scene, userText: "（客人安静地坐着，没有说话）", pack, nudge: true, photoWaiting: false },
      pack,
    );
    const spoken = beats.filter((beat) => beat.say !== "").map((beat) => beat.say);
    expect(spoken).toHaveLength(1);
    expect(pack.photoWaitingLines).not.toContain(spoken[0]);
  });

  it("台词按次序循环取（同一 nudge + 未就绪多轮）", () => {
    const picks: string[] = [];
    for (let index = 0; index < pack.photoWaitingLines.length + 1; index += 1) {
      const beats = composeBeats(
        { history: [], scene, userText: "（客人安静地坐着，没有说话）", pack, nudge: true, photoWaiting: true, photoWaitingIndex: index },
        pack,
      );
      const spoken = beats.find((beat) => beat.say !== "");
      picks.push(spoken?.say ?? "");
    }
    expect(picks.slice(0, pack.photoWaitingLines.length)).toEqual([...pack.photoWaitingLines]);
    // 循环：超出后回到第一句。
    expect(picks[pack.photoWaitingLines.length]).toBe(pack.photoWaitingLines[0]);
  });
});
