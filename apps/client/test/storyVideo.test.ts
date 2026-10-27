import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  initialVideoState,
  isVideoActive,
  isVideoStale,
  isVideoVisible,
  turnIdFromStoryEventId,
  VIDEO_FAILED_NOTICE,
  videoReducer,
  type VideoAction,
  type VideoState,
} from "../src/state/storyMedia";

const run = (state: VideoState, ...actions: VideoAction[]): VideoState => actions.reduce(videoReducer, state);

const loaded = (turnId = 4): VideoState =>
  videoReducer(initialVideoState, { type: "LOAD", eventId: "e1", turnId, url: "/stage/videos/clip_ending.webm" });

describe("视频：加载 / 播放 / 结束（S5 §5）", () => {
  it("LOAD → loading：视频层不可见，常驻角色照常", () => {
    const state = loaded();
    expect(state.status).toBe("loading");
    expect(isVideoVisible(state)).toBe(false);
    expect(state.url).toBe("/stage/videos/clip_ending.webm");
  });

  it("CANPLAY → playing：淡入覆盖角色区域", () => {
    const state = run(loaded(), { type: "CANPLAY", eventId: "e1" });
    expect(state.status).toBe("playing");
    expect(isVideoVisible(state)).toBe(true);
  });

  it("ENDED → ended：淡出，回到常驻角色", () => {
    const state = run(loaded(), { type: "CANPLAY", eventId: "e1" }, { type: "ENDED", eventId: "e1" });
    expect(state.status).toBe("ended");
    expect(isVideoVisible(state)).toBe(false);
  });

  it("loading 时收到 ENDED 不生效", () => {
    const state = run(loaded(), { type: "ENDED", eventId: "e1" });
    expect(state.status).toBe("loading");
  });
});

describe("视频：打断（D34 的明确例外）", () => {
  it("playing 时 A 换轮 → dismissed，立即结束且不恢复", () => {
    let state = run(loaded(4), { type: "CANPLAY", eventId: "e1" });
    state = videoReducer(state, { type: "TURN", turnId: 5 });
    expect(state.status).toBe("dismissed");
    expect(isVideoVisible(state)).toBe(false);
    // 旧事件的 CANPLAY 不能再把它拉回来。
    state = videoReducer(state, { type: "CANPLAY", eventId: "e1" });
    expect(state.status).toBe("dismissed");
  });

  it("loading 时换轮 → 也 dismissed（不会突然冒出来）", () => {
    const state = videoReducer(loaded(4), { type: "TURN", turnId: 5 });
    expect(state.status).toBe("dismissed");
  });

  it("TURN 到同一轮只更新镜像，不影响播放", () => {
    const playing = run(loaded(4), { type: "CANPLAY", eventId: "e1" });
    expect(videoReducer(playing, { type: "TURN", turnId: 4 })).toBe(playing);
  });

  it("打断后再来同一个事件不复活（LOAD 幂等）", () => {
    const dismissed = videoReducer(run(loaded(4), { type: "CANPLAY", eventId: "e1" }), { type: "TURN", turnId: 5 });
    const again = videoReducer(dismissed, { type: "LOAD", eventId: "e1", turnId: 4, url: "u" });
    expect(again).toBe(dismissed);
  });
});

describe("视频：失败（S5 §5）", () => {
  it("ERROR（加载错误）→ failed + 不打断提示，视频不出现", () => {
    const state = run(loaded(), { type: "ERROR", eventId: "e1" });
    expect(state.status).toBe("failed");
    expect(state.notice).toBe(VIDEO_FAILED_NOTICE);
    expect(isVideoVisible(state)).toBe(false);
  });

  it("TIMEOUT（>5s 没有 canplay）→ failed", () => {
    const state = run(loaded(), { type: "TIMEOUT", eventId: "e1" });
    expect(state.status).toBe("failed");
  });

  it("播放中途报错也走 failed", () => {
    const state = run(loaded(), { type: "CANPLAY", eventId: "e1" }, { type: "ERROR", eventId: "e1" });
    expect(state.status).toBe("failed");
  });

  it("已 ended / dismissed 之后再报错不改状态", () => {
    const ended = run(loaded(), { type: "CANPLAY", eventId: "e1" }, { type: "ENDED", eventId: "e1" });
    expect(videoReducer(ended, { type: "ERROR", eventId: "e1" })).toBe(ended);
  });
});

describe("视频：轮次与去重", () => {
  it("迟到的旧轮次 LOAD 被忽略（turnId 失效的视频不能出现）", () => {
    const later = videoReducer(initialVideoState, { type: "TURN", turnId: 6 });
    const stale = videoReducer(later, { type: "LOAD", eventId: "old", turnId: 5, url: "u" });
    expect(stale).toBe(later);
    expect(stale.status).toBe("idle");
  });

  it("事件 id 不匹配的播放事件一律忽略", () => {
    const state = run(loaded(), { type: "CANPLAY", eventId: "other" });
    expect(state.status).toBe("loading");
  });
});

describe("turnIdFromStoryEventId（S5 §5）", () => {
  it("从 <sessionId>:<turn>:<seq> 取轮次", () => {
    expect(turnIdFromStoryEventId("8f3e964-uuid:4:2")).toBe(4);
  });
  it("格式不对返回 null", () => {
    expect(turnIdFromStoryEventId("abc")).toBeNull();
    expect(turnIdFromStoryEventId("abc:x:1")).toBeNull();
  });
});

type Op =
  | { kind: "load"; turnId: number }
  | { kind: "canplay" }
  | { kind: "ended" }
  | { kind: "error" }
  | { kind: "timeout" }
  | { kind: "turn"; turnId: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("load" as const), turnId: fc.integer({ min: 0, max: 4 }) }),
  fc.constant({ kind: "canplay" as const }),
  fc.constant({ kind: "ended" as const }),
  fc.constant({ kind: "error" as const }),
  fc.constant({ kind: "timeout" as const }),
  fc.record({ kind: fc.constant("turn" as const), turnId: fc.integer({ min: 0, max: 4 }) }),
);

describe("视频：属性测试（架构关卡 §4 · 契约）", () => {
  it("随机事件序列下，失效轮次的视频不出现、同一时刻最多一个在播（1000 次）", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => {
        let state = initialVideoState;
        let eventId: string | null = null;
        let counter = 0;

        for (const op of ops) {
          if (op.kind === "load") {
            counter += 1;
            eventId = `e${counter}`;
            state = videoReducer(state, { type: "LOAD", eventId, turnId: op.turnId, url: "u" });
          } else if (op.kind === "turn") {
            state = videoReducer(state, { type: "TURN", turnId: op.turnId });
          } else if (eventId !== null) {
            const type = op.kind.toUpperCase() as "CANPLAY" | "ENDED" | "ERROR" | "TIMEOUT";
            state = videoReducer(state, { type, eventId });
          }

          // 契约 2：任何状态下，turnId 已失效的视频都不得出现（也不得还在推进）。
          if (isVideoActive(state) && isVideoStale(state)) return false;
          // 契约 1：同一时刻最多只有一个视频在播。
          const visibleCount = isVideoVisible(state) ? 1 : 0;
          if (visibleCount > 1) return false;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });
});
