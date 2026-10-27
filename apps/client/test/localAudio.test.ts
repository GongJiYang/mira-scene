/**
 * S6l-fix1 §6：本地音频单一音源仲裁的单测与属性测试。
 *
 * 规则：同一时刻只有一段声音；beat 播放期间兜底语音排队；打断停掉全部；叠加被记录。
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createLocalAudioChannel } from "../src/core/localAudio";

type Rig = {
  channel: ReturnType<typeof createLocalAudioChannel>;
  live: () => string[];
  overlaps: () => number;
};

function makeRig(): Rig {
  const playing = new Set<string>();
  let overlapCount = 0;
  const channel = createLocalAudioChannel({
    play: (url) => {
      playing.add(url);
      return {
        stop: () => {
          playing.delete(url);
        },
      };
    },
    onOverlap: () => {
      overlapCount += 1;
    },
  });
  return { channel, live: () => [...playing], overlaps: () => overlapCount };
}

describe("本地音频仲裁（S6l-fix1 §6）", () => {
  it("request 立即播放（无 beat）", () => {
    const rig = makeRig();
    rig.channel.request("offline.mp3");
    expect(rig.channel.isPlaying()).toBe(true);
    expect(rig.live()).toEqual(["offline.mp3"]);
  });

  it("beat 播放期间 request → 排队，beat 结束后才播", () => {
    const rig = makeRig();
    rig.channel.beatStarted();
    rig.channel.request("scene_failed.mp3");
    expect(rig.channel.isPlaying()).toBe(false);
    expect(rig.channel.hasQueued()).toBe(true);

    rig.channel.beatEnded();
    expect(rig.channel.isPlaying()).toBe(true);
    expect(rig.live()).toEqual(["scene_failed.mp3"]);
  });

  it("兜底语音播放中 beat 开始 → 兜底被停", () => {
    const rig = makeRig();
    rig.channel.request("offline.mp3");
    expect(rig.channel.isPlaying()).toBe(true);
    rig.channel.beatStarted();
    expect(rig.channel.isPlaying()).toBe(false);
    expect(rig.live()).toEqual([]);
  });

  it("打断 → 本地语音停且队列清空", () => {
    const rig = makeRig();
    rig.channel.request("offline.mp3");
    rig.channel.beatStarted();
    rig.channel.request("scene_failed.mp3"); // 排队
    rig.channel.stop();
    expect(rig.channel.isPlaying()).toBe(false);
    expect(rig.channel.hasQueued()).toBe(false);
    rig.channel.beatEnded();
    expect(rig.channel.isPlaying()).toBe(false);
  });

  it("替换正在播的语音（不叠加）", () => {
    const rig = makeRig();
    rig.channel.request("a.mp3");
    rig.channel.request("b.mp3");
    expect(rig.live()).toEqual(["b.mp3"]);
  });
});

describe("属性：任意时刻处于播放状态的本地音源 ≤ 1（S6l-fix1 §6）", () => {
  type Op = { kind: "request"; url: string } | { kind: "beatStarted" } | { kind: "beatEnded" } | { kind: "stop" };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant("request" as const), url: fc.constantFrom("a.mp3", "b.mp3", "c.mp3") }),
    fc.record({ kind: fc.constant("beatStarted" as const) }),
    fc.record({ kind: fc.constant("beatEnded" as const) }),
    fc.record({ kind: fc.constant("stop" as const) }),
  );

  it("随机操作序列：本地音源同时在播数 ≤ 1", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const rig = makeRig();
        let beatPlaying = false;
        for (const op of ops) {
          switch (op.kind) {
            case "request":
              rig.channel.request(op.url);
              break;
            case "beatStarted":
              beatPlaying = true;
              rig.channel.beatStarted();
              break;
            case "beatEnded":
              beatPlaying = false;
              rig.channel.beatEnded();
              break;
            case "stop":
              beatPlaying = false;
              rig.channel.stop();
              break;
          }
          // 不变量 1：本地音源同时在播 ≤ 1。
          expect(rig.live().length).toBeLessThanOrEqual(1);
          // 不变量 2：beat 在播时本地语音不得在播。
          if (beatPlaying) expect(rig.channel.isPlaying()).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("正常情况下不会触发叠加回调", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const rig = makeRig();
        for (const op of ops) {
          if (op.kind === "request") rig.channel.request(op.url);
          else if (op.kind === "beatStarted") rig.channel.beatStarted();
          else if (op.kind === "beatEnded") rig.channel.beatEnded();
          else rig.channel.stop();
        }
        expect(rig.overlaps()).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});
