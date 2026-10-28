/**
 * freeze-fix5 §3：`tts_degraded` 轻提示的显隐。
 *
 * - 收到当前轮的 `tts_degraded` → 显示（且不打断本轮，不进入错误态）；
 * - `turn_end` **不清除**；本轮播完回到 idle → 消失；
 * - 下一轮开始 → 消失；
 * - 旧 turnId 的迟到 `tts_degraded` → 不显示（遵守 D3）。
 */
import { describe, expect, it } from "vitest";
import type { Beat, ServerMessage } from "@mira/protocol";
import { pickNextPlayable, silentBeatMs } from "../src/core/scheduler";
import { initialState, reducer, type ClientAction, type ClientState } from "../src/state";
import { toStageView } from "../src/view/useStageViewModel";

const envelope = { v: 1, sessionId: "session-1", ts: 1_700_000_000_000 } as const;

const beatMsg = (turnId: number, seq: number, say: string): ServerMessage => ({
  ...envelope,
  type: "beat",
  turnId,
  seq,
  payload: {
    beat: { seq, say, emotion: "neutral", accent: null, hands: "cup", action: null, camera: null, fx: null, media: null, story: null } satisfies Beat,
  },
});

const ttsDegradedMsg = (turnId: number): ServerMessage => ({
  ...envelope,
  type: "error",
  turnId,
  seq: 0,
  payload: { code: "tts_degraded", message: "第 0 句语音合成失败，已降级为无声 beat", retryable: false },
});

const turnEndMsg = (turnId: number): ServerMessage => ({
  ...envelope,
  type: "turn_end",
  turnId,
  seq: 0,
  payload: { reason: "done" },
});

const run = (state: ClientState, ...actions: ClientAction[]): ClientState => actions.reduce(reducer, state);

/** 思考中（turnId = 1）的状态。 */
const thinkingWithTurn = (): ClientState => run(initialState, { type: "SUBMIT_TEXT" });

/** 从 reducer 状态读出「降级提示归属的轮次」。 */
const degradedTurn = (state: ClientState): number | null => state.ttsDegradedTurnId;

/** 从 reducer 状态经视图模型投影出「是否显示 tts 降级提示」。 */
const hint = (state: ClientState): boolean =>
  toStageView({ stage: state, connection: "open", sessionId: null, micError: null, events: [] }).ttsDegraded;

describe("tts_degraded 提示显隐（freeze-fix5 §2.2）", () => {
  it("收到当前轮 tts_degraded → 显示", () => {
    const state = thinkingWithTurn();
    expect(state.currentTurnId).toBe(1);
    const next = reducer(state, { type: "SERVER_MESSAGE", message: ttsDegradedMsg(1) });
    expect(degradedTurn(next)).toBe(1);
    expect(hint(next)).toBe(true);
  });

  it("tts_degraded 不打断本轮（不进入错误态、不清空）", () => {
    const state = thinkingWithTurn();
    const next = reducer(state, { type: "SERVER_MESSAGE", message: ttsDegradedMsg(1) });
    // 降级是非致命的：仍停留在本轮的正常 phase，而非 error。
    expect(next.phase.kind).not.toBe("error");
    expect(next.phase).toEqual(state.phase);
    // 不触发打断（audioStopToken 不变）。
    expect(next.audioStopToken).toBe(state.audioStopToken);
  });

  it("回到 idle（本轮播完）→ 提示消失；turn_end 本身不清除", () => {
    // speaking：本轮有 beat，第 1 句已在播。
    let state = run(
      thinkingWithTurn(),
      { type: "SERVER_MESSAGE", message: beatMsg(1, 0, "降级台词呀") },
      { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 },
      { type: "SERVER_MESSAGE", message: ttsDegradedMsg(1) },
    );
    expect(state.phase.kind).toBe("speaking");
    expect(hint(state)).toBe(true);

    // 续修：turn_end 到达时（此时第一句无声 beat 可能还在播）提示**不应**消失，
    // 否则剩余降级句会因 isTurnTtsDegraded 变 false 而卡在 speaking。
    state = reducer(state, { type: "SERVER_MESSAGE", message: turnEndMsg(1) });
    expect(hint(state)).toBe(true);

    // 本轮真正播完回 idle 时，提示才消失。
    state = reducer(state, { type: "BEAT_AUDIO_ENDED", turnId: 1, seq: 0 });
    expect(state.phase.kind).toBe("idle");
    expect(hint(state)).toBe(false);
  });

  it("下一轮开始 → 提示消失", () => {
    let state = thinkingWithTurn();
    state = reducer(state, { type: "SERVER_MESSAGE", message: ttsDegradedMsg(1) });
    expect(hint(state)).toBe(true);

    const nextTurn = reducer(state, { type: "SUBMIT_TEXT" });
    expect(nextTurn.currentTurnId).toBe(2);
    expect(hint(nextTurn)).toBe(false);
  });

  it("旧 turnId 的迟到 tts_degraded → 不显示（D3）", () => {
    const state = thinkingWithTurn(); // currentTurnId = 1
    expect(state.currentTurnId).toBe(1);
    const next = reducer(state, { type: "SERVER_MESSAGE", message: ttsDegradedMsg(0) });
    expect(next).toBe(state);
    expect(hint(next)).toBe(false);
  });
});

/**
 * freeze-fix5 续修：服务端 TTS 失败很快，`turn_end` 常在本轮**第一句无声 beat 还在播**时
 * 就到达。按 audio.ts 的调度方式（pickNextPlayable → BEAT_AUDIO_STARTED → 停留 silentBeatMs
 * → BEAT_AUDIO_ENDED）跑完 3 句降级 beat，验证 3 句都按可读时长播完并回到 idle。
 *
 * 缺陷回归：若 markTurnEnded 在收到 turn_end 时清掉 ttsDegradedTurnId，则 turn_end 之后
 * isTurnTtsDegraded 变 false，pickNextPlayable 对剩余降级句返回 null，整轮卡死在 speaking。
 */
describe("TTS 降级整轮：turn_end 早于播放结束（freeze-fix5 续修）", () => {
  it("turn_end 在第 1 句播放中到达 → 3 句都按 silentBeatMs 播完并回到 idle", () => {
    const says: [string, string, string] = ["第一句降级台词呀", "第二句降级台词呀", "第三句降级台词呀"];
    const seqs = [0, 1, 2] as const;
    // 3 句 beat + 本轮 tts_degraded。
    let state = run(
      thinkingWithTurn(),
      ...seqs.map((seq) => ({ type: "SERVER_MESSAGE" as const, message: beatMsg(1, seq, says[seq]) })),
      { type: "SERVER_MESSAGE", message: ttsDegradedMsg(1) },
    );

    const played: number[] = [];
    const durations: number[] = [];

    // 第 1 句：播放中（此时队列还剩 seq 1、2）。
    expect(pickNextPlayable(state, new Set(), false)).toEqual({ seq: 0, silent: true });
    state = reducer(state, { type: "BEAT_AUDIO_STARTED", turnId: 1, seq: 0 });
    played.push(0);
    durations.push(silentBeatMs(says[0]));

    // 第 1 句还在播时，turn_end 到达（服务端很快）。
    state = reducer(state, { type: "SERVER_MESSAGE", message: turnEndMsg(1) });
    expect(state.turnEnded).toBe(true);
    expect(state.phase.kind).toBe("speaking");

    // 第 1 句播完 → 队列还有剩余，保持 speaking。
    state = reducer(state, { type: "BEAT_AUDIO_ENDED", turnId: 1, seq: 0 });
    expect(state.phase.kind).toBe("speaking");

    // 第 2、3 句：turn_end 已到，但降级标记仍在 → 仍按无声路径播完（不卡死）。
    for (const seq of [1, 2] as const) {
      expect(pickNextPlayable(state, new Set(), false)).toEqual({ seq, silent: true });
      state = reducer(state, { type: "BEAT_AUDIO_STARTED", turnId: 1, seq });
      played.push(seq);
      durations.push(silentBeatMs(says[seq]));
      state = reducer(state, { type: "BEAT_AUDIO_ENDED", turnId: 1, seq });
    }

    // 3 句都播了、都按 silentBeatMs 停留，本轮回到 idle，提示消失。
    expect(played).toEqual([0, 1, 2]);
    expect(durations).toEqual([silentBeatMs(says[0]), silentBeatMs(says[1]), silentBeatMs(says[2])]);
    expect(state.phase.kind).toBe("idle");
    expect(hint(state)).toBe(false);
  });
});
