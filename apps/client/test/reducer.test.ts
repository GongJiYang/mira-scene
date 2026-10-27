import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Beat, SceneState, ServerMessage } from "@mira/protocol";
import { initialState, nextBeatToPlay, reducer, type ClientAction, type ClientState } from "../src/state";

const makeBeat = (seq: number, overrides: Partial<Beat> = {}): Beat => ({
  seq,
  say: `第 ${seq} 句`,
  emotion: "warm",
  accent: null,
  hands: "cup",
  action: null,
  camera: null,
  fx: null,
  media: null,
  story: null,
  ...overrides,
});

const envelope = { v: 1, sessionId: "session-1", ts: 1_700_000_000_000 } as const;

const beatMsg = (turnId: number, beat: Beat): ServerMessage => ({
  ...envelope,
  type: "beat",
  turnId,
  seq: beat.seq,
  payload: { beat },
});

const turnEndMsg = (turnId: number): ServerMessage => ({
  ...envelope,
  type: "turn_end",
  turnId,
  seq: 0,
  payload: { reason: "done" },
});

const errorMsg = (turnId: number, scope?: "session" | "turn"): ServerMessage => ({
  ...envelope,
  type: "error",
  turnId,
  seq: 0,
  payload: { code: "llm_timeout", message: "超时", retryable: true, ...(scope ? { scope } : {}) },
});

const makeSnapshot = (overrides: Partial<SceneState> = {}): SceneState => ({
  node: "probe",
  trust: 2,
  flags: ["met"],
  emotion: "sad",
  hands: "phone",
  camera: "close_up",
  fx: "lights_dim",
  turnCount: 4,
  ...overrides,
});

const sessionMsg = (turnId: number, snapshot: SceneState): ServerMessage => ({
  ...envelope,
  type: "session",
  turnId,
  seq: 0,
  payload: { snapshot },
});

const stateSnapshotMsg = (turnId: number, snapshot: SceneState): ServerMessage => ({
  ...envelope,
  type: "state_snapshot",
  turnId,
  seq: 0,
  payload: { snapshot },
});

const run = (state: ClientState, ...actions: ClientAction[]): ClientState => actions.reduce(reducer, state);

const idleWithTurn = (): ClientState =>
  run(initialState, { type: "SUBMIT_TEXT" }, { type: "SERVER_MESSAGE", message: turnEndMsg(1) });

const listeningWithTurn = (): ClientState => run(initialState, { type: "PTT_DOWN" });

const thinkingWithTurn = (): ClientState =>
  run(initialState, { type: "PTT_DOWN" }, { type: "PTT_UP" });

const speakingWithTurn = (): ClientState =>
  run(
    initialState,
    { type: "SUBMIT_TEXT" },
    {
      type: "SERVER_MESSAGE",
      message: beatMsg(
        1,
        makeBeat(0, { say: "你来了。", media: { type: "video", id: "letter_reveal" } }),
      ),
    },
    { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
  );

describe("turnId 过滤（D3）", () => {
  const phases: Array<[string, () => ClientState]> = [
    ["idle", idleWithTurn],
    ["listening", listeningWithTurn],
    ["thinking", thinkingWithTurn],
    ["speaking", speakingWithTurn],
  ];

  it.each(phases)("%s 状态下丢弃旧轮次的 beat / turn_end", (label, build) => {
    const state = build();
    expect(state.phase.kind).toBe(label);
    expect(state.currentTurnId).toBe(1);
    const staleTurn = state.currentTurnId - 1;
    const staleMessages = [
      beatMsg(staleTurn, makeBeat(0)),
      turnEndMsg(staleTurn),
      errorMsg(staleTurn),
    ];
    for (const message of staleMessages) {
      expect(reducer(state, { type: "SERVER_MESSAGE", message })).toBe(state);
    }
  });

  it("旧轮次的轮次级 error 被丢弃（D3 / Q1 打断语义）", () => {
    const state = thinkingWithTurn();
    expect(state.currentTurnId).toBe(1);
    // 轮次级 error（llm_timeout / turn_failed 等）在打断后迟到，不得改变状态。
    expect(reducer(state, { type: "SERVER_MESSAGE", message: errorMsg(0) })).toBe(state);
    expect(reducer(state, { type: "SERVER_MESSAGE", message: errorMsg(999) })).toBe(state);
  });

  it("会话级 error 不按 turnId 过滤：必须进入错误态", () => {
    const state = thinkingWithTurn();
    expect(state.currentTurnId).toBe(1);
    const next = reducer(state, { type: "SERVER_MESSAGE", message: errorMsg(0, "session") });
    expect(next.phase).toEqual({
      kind: "error",
      code: "llm_timeout",
      message: "超时",
      retryable: true,
    });
  });

  it("当前轮的轮次级 error 进入错误态", () => {
    const state = thinkingWithTurn();
    expect(state.currentTurnId).toBe(1);
    const next = reducer(state, { type: "SERVER_MESSAGE", message: errorMsg(1) });
    expect(next.phase).toEqual({
      kind: "error",
      code: "llm_timeout",
      message: "超时",
      retryable: true,
    });
  });

  it("fast-check：任意非当前轮的轮次级 error 都不改变状态", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }).filter((t) => t !== 1),
        (staleTurn) => {
          const state = thinkingWithTurn();
          expect(reducer(state, { type: "SERVER_MESSAGE", message: errorMsg(staleTurn) })).toBe(state);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("打断后迟到的上一轮 turn_end 不会把 phase 改为 idle", () => {
    const listening = reducer(speakingWithTurn(), { type: "PTT_DOWN" });
    const afterLateTurnEnd = reducer(listening, {
      type: "SERVER_MESSAGE",
      message: turnEndMsg(1),
    });
    expect(afterLateTurnEnd).toBe(listening);
    expect(afterLateTurnEnd.phase.kind).toBe("listening");
  });

  it("打断后旧轮次的音频回调（STARTED / ENDED）被丢弃", () => {
    const listening = reducer(speakingWithTurn(), { type: "PTT_DOWN" });
    expect(reducer(listening, { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 })).toBe(listening);
    expect(reducer(listening, { type: "BEAT_AUDIO_ENDED", turnId: 1, seq: 0 })).toBe(listening);
  });

  it("连续 SUBMIT_TEXT 三次后只接受最后一轮的 beat", () => {
    let state = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      { type: "SUBMIT_TEXT" },
      { type: "SUBMIT_TEXT" },
    );
    expect(state.currentTurnId).toBe(3);

    state = run(
      state,
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0)) },
      { type: "SERVER_MESSAGE", message: beatMsg(2, makeBeat(0)) },
    );
    expect(state.queue).toHaveLength(0);

    state = reducer(state, { type: "SERVER_MESSAGE", message: beatMsg(3, makeBeat(1)) });
    expect(state.queue.map((beat) => beat.seq)).toEqual([1]);
  });
});

describe("打断与输入", () => {
  it("speaking 时 PTT_DOWN：立即进入 listening 并清空当前轮", () => {
    const state = speakingWithTurn();
    const tokenBefore = state.audioStopToken;
    expect(state.subtitle).not.toBeNull();
    expect(state.media).not.toBeNull();

    const next = reducer(state, { type: "PTT_DOWN" });
    expect(next.phase).toEqual({ kind: "listening" });
    expect(next.queue).toEqual([]);
    expect(next.currentTurnId).toBe(2);
    expect(next.audioStopToken).toBe(tokenBefore + 1);
    expect(next.subtitle).toBeNull();
    expect(next.media).toBeNull();
  });

  it("PTT_UP 只在 listening 时生效", () => {
    const listening = listeningWithTurn();
    const thinking = reducer(listening, { type: "PTT_UP" });
    expect(thinking.phase).toEqual({ kind: "thinking" });
    expect(thinking.currentTurnId).toBe(listening.currentTurnId);
    expect(reducer(thinking, { type: "PTT_UP" })).toBe(thinking);
  });

  it("SUBMIT_TEXT 的清理与 PTT_DOWN 相同，但进入 thinking", () => {
    const speaking = speakingWithTurn();
    const tokenBefore = speaking.audioStopToken;
    const next = reducer(speaking, { type: "SUBMIT_TEXT" });
    expect(next.phase).toEqual({ kind: "thinking" });
    expect(next.currentTurnId).toBe(speaking.currentTurnId + 1);
    expect(next.queue).toEqual([]);
    expect(next.subtitle).toBeNull();
    expect(next.media).toBeNull();
    expect(next.audioStopToken).toBe(tokenBefore + 1);
  });

  it("RETRY 只在 error 时回到 idle", () => {
    const errorState = reducer(
      reducer(initialState, { type: "SUBMIT_TEXT" }),
      { type: "SERVER_MESSAGE", message: errorMsg(1) },
    );
    expect(errorState.phase).toEqual({
      kind: "error",
      code: "llm_timeout",
      message: "超时",
      retryable: true,
    });
    expect(reducer(initialState, { type: "RETRY" })).toBe(initialState);
    expect(reducer(errorState, { type: "RETRY" }).phase).toEqual({ kind: "idle" });
  });

  it("error 清空 queue 与 subtitle，并让 audioStopToken +1", () => {
    let state = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0, { say: "第一句" })) },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(1, { say: "第二句" })) },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
    );
    // 前置：正在播放 seq 0，seq 1 还在 queue 中。
    expect(state.phase).toEqual({ kind: "speaking", seq: 0 });
    expect(state.queue.map((beat) => beat.seq)).toEqual([1]);
    expect(state.subtitle).toBe("第一句");
    const tokenBefore = state.audioStopToken;

    state = reducer(state, { type: "SERVER_MESSAGE", message: errorMsg(1) });
    expect(state.phase).toEqual({
      kind: "error",
      code: "llm_timeout",
      message: "超时",
      retryable: true,
    });
    expect(state.queue).toEqual([]);
    expect(state.subtitle).toBeNull();
    expect(state.audioStopToken).toBe(tokenBefore + 1);
  });
});

describe("beat 与视觉/字幕", () => {
  it("收到 beat 时 visual 和 subtitle 不变，BEAT_AUDIO_STARTED 之后才生效", () => {
    const incoming = makeBeat(0, {
      say: "雨停了吗？",
      emotion: "sad",
      hands: "phone",
      action: "glance",
      camera: "close_up",
      fx: "rain_stop",
    });
    let state = reducer(initialState, { type: "SUBMIT_TEXT" });
    state = reducer(state, { type: "SERVER_MESSAGE", message: beatMsg(1, incoming) });
    expect(state.visual).toEqual(initialState.visual);
    expect(state.subtitle).toBeNull();

    state = reducer(state, { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 });
    expect(state.subtitle).toBe("雨停了吗？");
    expect(state.visual).toEqual({
      emotion: "sad",
      hands: "phone",
      action: "glance",
      camera: "close_up",
      fx: "rain_stop",
      accent: null,
    });
  });

  it("action / camera / fx / media 为 null 时保持上一句的值", () => {
    const state = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      {
        type: "SERVER_MESSAGE",
        message: beatMsg(
          1,
          makeBeat(0, {
            emotion: "sad",
            hands: "phone",
            action: "glance",
            camera: "close_up",
            fx: "rain_stop",
            media: { type: "photo", id: "photo" },
          }),
        ),
      },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
      {
        type: "SERVER_MESSAGE",
        message: beatMsg(1, makeBeat(1, { emotion: "warm", hands: "cup" })),
      },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 1 },
    );
    expect(state.visual).toEqual({
      emotion: "warm",
      hands: "cup",
      action: "glance",
      camera: "close_up",
      fx: "rain_stop",
      accent: null,
    });
    expect(state.media).toEqual({ type: "photo", id: "photo" });
    expect(state.phase).toEqual({ kind: "speaking", seq: 1 });
  });

  it("D47：accent 逐句生效，下一句为 null 时立即清掉", () => {
    let state = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0, { accent: "amazed" })) },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
    );
    expect(state.visual.accent).toBe("amazed");

    state = run(
      state,
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(1, { accent: null })) },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 1 },
    );
    expect(state.visual.accent).toBeNull();
  });

  it("S6l-fix2 §3：带 accent 的 beat 播完 turn_end → idle 后 accent 为 null", () => {
    const state = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0, { accent: "fly_head" })) },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
      { type: "SERVER_MESSAGE", message: turnEndMsg(1) },
      { type: "BEAT_AUDIO_ENDED", turnId: 1, seq: 0 },
    );
    expect(state.phase).toEqual({ kind: "idle" });
    expect(state.visual.accent).toBeNull();
  });

  it("S6l-fix2 §3：带 accent 的 beat 中 PTT_DOWN / SUBMIT_TEXT 打断 → accent 清空", () => {
    const speaking = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0, { accent: "black" })) },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
    );
    expect(speaking.visual.accent).toBe("black");
    expect(reducer(speaking, { type: "PTT_DOWN" }).visual.accent).toBeNull();
    expect(reducer(speaking, { type: "SUBMIT_TEXT" }).visual.accent).toBeNull();
  });

  it("S6l-fix2 §3：点击打断（listening）用 INPUT_CANCELLED 回 idle 时 accent 清空", () => {
    const speaking = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0, { accent: "dark" })) },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
    );
    // 模拟点击打断：先 PTT_DOWN 进入 listening（已清 accent），再 INPUT_CANCELLED 回 idle。
    const listening = reducer(speaking, { type: "PTT_DOWN" });
    const idle = reducer(listening, { type: "INPUT_CANCELLED", turnId: listening.currentTurnId });
    expect(idle.phase).toEqual({ kind: "idle" });
    expect(idle.visual.accent).toBeNull();
  });

  it("重复 seq 的 beat 被忽略", () => {
    const state = run(
      reducer(initialState, { type: "SUBMIT_TEXT" }),
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0, { say: "第一次" })) },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0, { say: "第二次" })) },
    );
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]?.say).toBe("第一次");
  });

  it("seq 乱序到达时 nextBeatToPlay 返回 seq 最小的 beat", () => {
    const state = run(
      reducer(initialState, { type: "SUBMIT_TEXT" }),
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(1)) },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0)) },
    );
    expect(state.queue.map((beat) => beat.seq)).toEqual([0, 1]);
    expect(nextBeatToPlay(state)?.seq).toBe(0);
    expect(nextBeatToPlay(initialState)).toBeNull();
  });

  it("session / state_snapshot 不受 turnId 过滤，只覆盖视觉持续字段且不动 phase", () => {
    const state = run(initialState, { type: "SUBMIT_TEXT" });
    const afterSession = reducer(state, {
      type: "SERVER_MESSAGE",
      message: sessionMsg(999, makeSnapshot()),
    });
    // session 的 turnId 同步见下一个用例；这里只断言视觉与 phase。
    expect(afterSession.phase).toEqual(state.phase);
    expect(afterSession.visual).toEqual({
      emotion: "sad",
      hands: "phone",
      action: null,
      camera: "close_up",
      fx: "lights_dim",
      accent: null,
    });

    const afterSnapshot = reducer(state, {
      type: "SERVER_MESSAGE",
      message: stateSnapshotMsg(
        999,
        makeSnapshot({ emotion: "guarded", hands: "polaroid", camera: null, fx: null }),
      ),
    });
    expect(afterSnapshot.currentTurnId).toBe(state.currentTurnId);
    expect(afterSnapshot.visual).toEqual({
      emotion: "guarded",
      hands: "polaroid",
      action: null,
      camera: null,
      fx: null,
      accent: null,
    });
  });
});

describe("恢复会话时同步 turnId（S2 修复 1）", () => {
  it("本地 0，收到 turnId=5 的 session → 5；之后 SUBMIT_TEXT → 6", () => {
    expect(initialState.currentTurnId).toBe(0);
    const restored = reducer(initialState, {
      type: "SERVER_MESSAGE",
      message: sessionMsg(5, makeSnapshot()),
    });
    expect(restored.currentTurnId).toBe(5);

    const submitted = reducer(restored, { type: "SUBMIT_TEXT" });
    expect(submitted.currentTurnId).toBe(6);
  });

  it("本地 7，收到 turnId=5 的 session → 仍是 7（不回退）", () => {
    let state = run(initialState, ...Array.from({ length: 7 }, () => ({ type: "SUBMIT_TEXT" }) as const));
    expect(state.currentTurnId).toBe(7);

    state = reducer(state, { type: "SERVER_MESSAGE", message: sessionMsg(5, makeSnapshot()) });
    expect(state.currentTurnId).toBe(7);
  });
});

describe("INPUT_CANCELLED（S2 修复 2）", () => {
  it("listening / thinking 下取消 → 回到 idle，turnId 不回退", () => {
    for (const build of [listeningWithTurn, thinkingWithTurn]) {
      const state = build();
      const cancelled = reducer(state, { type: "INPUT_CANCELLED", turnId: state.currentTurnId });
      expect(cancelled.phase).toEqual({ kind: "idle" });
      expect(cancelled.currentTurnId).toBe(state.currentTurnId);
      expect(cancelled.queue).toEqual([]);
      expect(cancelled.subtitle).toBeNull();
    }
  });

  it("旧 turnId → 同一个引用", () => {
    const thinking = thinkingWithTurn();
    expect(reducer(thinking, { type: "INPUT_CANCELLED", turnId: thinking.currentTurnId - 1 })).toBe(thinking);
  });

  it("speaking 下 → 不变（同一个引用）", () => {
    const speaking = speakingWithTurn();
    expect(reducer(speaking, { type: "INPUT_CANCELLED", turnId: speaking.currentTurnId })).toBe(speaking);
  });
});

describe("剧情层与心跳消息（D27）", () => {
  const mediaReadyMsg = (turnId: number, status: "ready" | "fallback"): ServerMessage => ({
    ...envelope,
    type: "media_ready",
    turnId,
    seq: 0,
    payload: { storyEventId: "story-1", media: { type: "photo", id: "photo_letters" }, status },
  });

  it("media_ready 不按 turnId 过滤，本批原样忽略", () => {
    const speaking = speakingWithTurn();
    expect(reducer(speaking, { type: "SERVER_MESSAGE", message: mediaReadyMsg(999, "ready") })).toBe(speaking);
    expect(reducer(speaking, { type: "SERVER_MESSAGE", message: mediaReadyMsg(1, "fallback") })).toBe(speaking);
  });

  it("pong 原样忽略", () => {
    const speaking = speakingWithTurn();
    const pong: ServerMessage = { ...envelope, type: "pong", turnId: 999, seq: 0, payload: {} };
    expect(reducer(speaking, { type: "SERVER_MESSAGE", message: pong })).toBe(speaking);
  });
});

describe("一轮完整流程", () => {
  it("SUBMIT_TEXT → 2 个 beat → 依次 STARTED/ENDED → turn_end → idle", () => {
    const state = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0, { say: "第一句" })) },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(1, { say: "第二句" })) },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
      { type: "BEAT_AUDIO_ENDED", turnId: 1, seq: 0 },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 1 },
      { type: "BEAT_AUDIO_ENDED", turnId: 1, seq: 1 },
      { type: "SERVER_MESSAGE", message: turnEndMsg(1) },
    );
    expect(state.currentTurnId).toBe(1);
    expect(state.queue).toEqual([]);
    expect(state.turnEnded).toBe(true);
    expect(state.phase).toEqual({ kind: "idle" });
  });

  it("最后一句 ENDED 后 turn_end 未到：进入 thinking（subtitle=null），新 beat 的 STARTED 恢复 speaking", () => {
    let state = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0, { say: "第一句" })) },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
      { type: "BEAT_AUDIO_ENDED", turnId: 1, seq: 0 },
    );
    expect(state.turnEnded).toBe(false);
    expect(state.phase).toEqual({ kind: "thinking" });
    expect(state.subtitle).toBeNull();
    expect(state.queue).toEqual([]);

    state = run(
      state,
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(1, { say: "第二句" })) },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 1 },
    );
    expect(state.phase).toEqual({ kind: "speaking", seq: 1 });
    expect(state.subtitle).toBe("第二句");
  });

  it("turn_end 先于最后一个 beat 的 ENDED 到达时，要等 ENDED 之后才 idle", () => {
    let state = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0)) },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
      { type: "SERVER_MESSAGE", message: turnEndMsg(1) },
    );
    // 最后一个 beat 在 STARTED 时已出队，但音频仍在播放：不得提前 idle。
    expect(state.turnEnded).toBe(true);
    expect(state.phase).toEqual({ kind: "speaking", seq: 0 });

    state = reducer(state, { type: "BEAT_AUDIO_ENDED", turnId: 1, seq: 0 });
    expect(state.phase).toEqual({ kind: "idle" });
    expect(state.subtitle).toBeNull();
    expect(state.queue).toEqual([]);
  });

  it("多 beat 场景中 turn_end 在第二个 beat 播放期间到达：仍 speaking，第二个 ENDED 后 idle", () => {
    let state = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(0, { say: "第一句" })) },
      { type: "SERVER_MESSAGE", message: beatMsg(1, makeBeat(1, { say: "第二句" })) },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
      { type: "BEAT_AUDIO_ENDED", turnId: 1, seq: 0 },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 1 },
      { type: "SERVER_MESSAGE", message: turnEndMsg(1) },
    );
    expect(state.turnEnded).toBe(true);
    expect(state.phase).toEqual({ kind: "speaking", seq: 1 });
    expect(state.subtitle).toBe("第二句");

    state = reducer(state, { type: "BEAT_AUDIO_ENDED", turnId: 1, seq: 1 });
    expect(state.phase).toEqual({ kind: "idle" });
    expect(state.subtitle).toBeNull();
    expect(state.queue).toEqual([]);
  });

  it("thinking 状态下未收到任何 beat 就 turn_end → idle，subtitle 为 null", () => {
    const state = run(
      initialState,
      { type: "SUBMIT_TEXT" },
      { type: "SERVER_MESSAGE", message: turnEndMsg(1) },
    );
    expect(state.turnEnded).toBe(true);
    expect(state.phase).toEqual({ kind: "idle" });
    expect(state.subtitle).toBeNull();
    expect(state.queue).toEqual([]);
  });

  it("started 的 beat 不在 queue 中时丢弃回调", () => {
    const thinking = thinkingWithTurn();
    expect(reducer(thinking, { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 5 })).toBe(thinking);
  });
});
