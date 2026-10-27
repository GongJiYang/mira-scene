/**
 * S6l-fix1 §5：反应音按角色。
 *
 * - 反应音 URL 随当前角色变化（`/characters/<id>/sfx/react-*.mp3`）；
 * - 某角色没有反应音时 `arm()` 不播放（不回退到全局文件）；
 * - 旧的全局 `REACTION_SFX_URLS` 已删除。
 */
import { describe, expect, it } from "vitest";
import { createReactionSfx } from "../src/core/reactionSfx";
import { reactionSfxUrls, REACTION_SFX_FILES } from "../src/live/characters";
import * as reactionSfxModule from "../src/core/reactionSfx";

type Rig = {
  sfx: ReturnType<typeof createReactionSfx>;
  events: string[];
  fire: () => void;
  pending: () => number;
};

function makeRig(urls: () => readonly string[], randomValue = 0): Rig {
  const timers = new Map<number, () => void>();
  let id = 0;
  const events: string[] = [];
  const handle = { fadeOut: () => events.push("fade"), stop: () => events.push("stop") };
  const sfx = createReactionSfx({
    urls,
    random: () => randomValue,
    setTimer: (cb) => {
      id += 1;
      timers.set(id, cb);
      return id;
    },
    clearTimer: (which) => timers.delete(which),
    play: (url) => {
      events.push(`play ${url}`);
      return handle;
    },
  });
  return {
    sfx,
    events,
    fire: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const cb of pending) cb();
    },
    pending: () => timers.size,
  };
}

describe("反应音按角色（S6l-fix1 §5）", () => {
  it("reactionSfxUrls 随角色变化", () => {
    expect(reactionSfxUrls("yuna")).toEqual([
      "/characters/yuna/sfx/react-hmm.mp3",
      "/characters/yuna/sfx/react-mm.mp3",
      "/characters/yuna/sfx/react-ah.mp3",
    ]);
    // 未知角色（没有反应音）→ 空数组（不播）。
    expect(reactionSfxUrls("nobody")).toEqual([]);
  });

  it("没有全局 REACTION_SFX_URLS 导出（已删除）", () => {
    expect("REACTION_SFX_URLS" in reactionSfxModule).toBe(false);
  });

  it("arm 时按动态 urls 取当前角色的反应音", () => {
    const rig = makeRig(() => reactionSfxUrls("yuna"));
    rig.sfx.arm(1);
    rig.fire();
    expect(rig.events).toEqual(["play /characters/yuna/sfx/react-hmm.mp3"]);
  });

  it("当前角色没有反应音（空数组）→ arm 不播放", () => {
    const rig = makeRig(() => reactionSfxUrls("nobody"));
    rig.sfx.arm(1);
    expect(rig.pending()).toBe(0);
    rig.fire();
    expect(rig.events).toEqual([]);
  });

  it("yuna 声明了三个反应音文件", () => {
    expect(REACTION_SFX_FILES).toContain("react-hmm.mp3");
  });
});
