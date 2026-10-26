import { beforeEach, describe, expect, it } from "vitest";
import {
  createReactionSfx,
  installReactionSfx,
  reactionSfx,
  REACTION_ARM_DELAY_MS,
  REACTION_FADE_MS,
} from "../src/core/reactionSfx";

type Scheduler = {
  setTimer: (callback: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  fire(): void;
  pending(): number;
  delays: number[];
};

function makeScheduler(): Scheduler {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let id = 0;
  return {
    setTimer(callback, ms) {
      id += 1;
      timers.set(id, callback);
      delays.push(ms);
      return id;
    },
    clearTimer(which) {
      timers.delete(which);
    },
    fire() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, callback] of pending) callback();
    },
    pending() {
      return timers.size;
    },
    delays,
  };
}

type Rig = {
  sfx: ReturnType<typeof createReactionSfx>;
  scheduler: Scheduler;
  events: string[];
};

function makeRig(randomValue = 0, urls: string[] = ["a.mp3", "b.mp3"]): Rig {
  const scheduler = makeScheduler();
  const events: string[] = [];
  const handle = {
    fadeOut(ms: number) {
      events.push(`fade ${ms}`);
    },
    stop() {
      events.push("stop");
    },
  };
  const sfx = createReactionSfx({
    urls,
    random: () => randomValue,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    play: (url) => {
      events.push(`play ${url}`);
      return handle;
    },
  });
  return { sfx, scheduler, events };
}

describe("reactionSfx（§5）", () => {
  it("arm 后 150ms 内随机播放一条", () => {
    const rig = makeRig(0);
    rig.sfx.arm(1);
    expect(rig.events).toEqual([]);
    expect(rig.scheduler.delays).toEqual([REACTION_ARM_DELAY_MS]);
    rig.scheduler.fire();
    expect(rig.events).toEqual(["play a.mp3"]);
  });

  it("random 决定播放哪一条", () => {
    const rig = makeRig(0.9);
    rig.sfx.arm(1);
    rig.scheduler.fire();
    expect(rig.events).toEqual(["play b.mp3"]);
  });

  it("第一个真实 beat 开始 → 淡出（80ms）", () => {
    const rig = makeRig();
    rig.sfx.arm(1);
    rig.scheduler.fire();
    rig.sfx.fadeOut();
    expect(rig.events).toEqual(["play a.mp3", `fade ${REACTION_FADE_MS}`]);
  });

  it("打断 → 立即停止", () => {
    const rig = makeRig();
    rig.sfx.arm(1);
    rig.scheduler.fire();
    rig.sfx.stop();
    expect(rig.events).toEqual(["play a.mp3", "stop"]);
  });

  it("定时器还没触发就打断 → 不会播放", () => {
    const rig = makeRig();
    rig.sfx.arm(1);
    rig.sfx.stop();
    expect(rig.scheduler.pending()).toBe(0);
    rig.scheduler.fire();
    expect(rig.events).toEqual([]);
  });

  it("再次 arm 会重置上一条", () => {
    const rig = makeRig();
    rig.sfx.arm(1);
    rig.sfx.arm(2);
    rig.scheduler.fire();
    expect(rig.events).toEqual(["play a.mp3"]);
  });

  it("urls 为空时不调度", () => {
    const rig = makeRig(0, []);
    rig.sfx.arm(1);
    expect(rig.scheduler.pending()).toBe(0);
  });
});

describe("reactionSfx 单例注册", () => {
  beforeEach(() => {
    installReactionSfx(createReactionSfx({ urls: [], random: () => 0, setTimer: () => 0, clearTimer: () => {}, play: () => null }));
  });

  it("install / getter", () => {
    const custom = createReactionSfx({ urls: [], random: () => 0, setTimer: () => 0, clearTimer: () => {}, play: () => null });
    installReactionSfx(custom);
    expect(reactionSfx()).toBe(custom);
  });
});
