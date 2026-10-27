import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Beat, Media, ServerMessage } from "@mira/protocol";
import { createInterruptExecutor, type InterruptDeps } from "../src/core/interrupt";
import { createTimeline, timelineCountForTurn, timelineStoryCount } from "../src/core/timeline";
import { pickNextPlayable } from "../src/core/scheduler";
import { initialState, reducer, type ClientState } from "../src/state";
import { initialPerformanceState, performanceReducer, type PerformanceState } from "../src/state/performance";
import { initialStoryMediaState, storyMediaReducer, type StoryMediaState } from "../src/state/storyMedia";

/**
 * §4 打断矩阵：模拟客户端核心（真实 A/B/C reducer + 真实时间线 + 假音频 + 假音量源）。
 * 用 fast-check 生成随机交错的事件序列，在任意位置插入打断，断言 5 条不变量（运行 1000 次）。
 * 另有 7 个确定性用例覆盖矩阵的 7 种情况。
 */

const ENVELOPE = { v: 1, sessionId: "s", ts: 0 } as const;

function makeBeat(seq: number, overrides: Partial<Beat> = {}): Beat {
  return {
    seq,
    say: `第${seq}句`,
    emotion: "warm",
    accent: null,
    hands: "cup",
    action: null,
    camera: null,
    fx: null,
    media: null,
    story: null,
    ...overrides,
  };
}

const beatMsg = (turnId: number, beat: Beat): ServerMessage => ({
  ...ENVELOPE,
  type: "beat",
  turnId,
  seq: beat.seq,
  payload: { beat },
});

const turnEndMsg = (turnId: number): ServerMessage => ({
  ...ENVELOPE,
  type: "turn_end",
  turnId,
  seq: 0,
  payload: { reason: "done" },
});

const PHOTO: Media = { type: "photo", id: "photo_letters", storyEventId: "story-1" };

function cRank(status: StoryMediaState["status"]): number {
  switch (status) {
    case "none":
      return 0;
    case "developing":
      return 1;
    case "fallback":
    case "ready":
      return 2;
    case "shown":
      return 3;
  }
}

type Reasons = "ptt" | "text";

function createSim() {
  let A: ClientState = initialState;
  let B: PerformanceState = initialPerformanceState;
  let C: StoryMediaState = initialStoryMediaState;
  let now = 0;
  const timeline = createTimeline({
    now: () => now,
    setTimer: () => 0,
    clearTimer: () => {},
  });

  let playing: { turnId: number; seq: number } | null = null;
  let silentPending = false;
  let reactionActive = false;
  // S6l-fix1 §6：本地兜底语音是否在播（打断后必须停）。
  let localVoiceActive = false;
  const ready = new Set<number>();
  const decoding = new Set<number>();
  const sentInterrupts: number[] = [];
  const violations: string[][] = [];
  let lastPhaseKind = A.phase.kind;
  let lastSpeakingSeq: number | null = null;

  function dispatchA(action: Parameters<typeof reducer>[1]): void {
    A = reducer(A, action);
    syncDerived();
  }

  function syncDerived(): void {
    const kind = A.phase.kind;
    if (kind !== lastPhaseKind) {
      lastPhaseKind = kind;
      B = performanceReducer(B, { type: "PHASE", phase: kind, at: now });
    }
    if (kind === "speaking" && A.phase.kind === "speaking") {
      const seq = A.phase.seq;
      if (seq !== lastSpeakingSeq) {
        lastSpeakingSeq = seq;
        B = performanceReducer(B, {
          type: "BEAT_STARTED",
          look: { emotion: A.visual.emotion, action: A.visual.action },
          at: now,
        });
      }
    } else {
      lastSpeakingSeq = null;
    }
    C = storyMediaReducer(C, { type: "PHASE", phase: kind });
  }

  function mouthClosed(): void {
    B = performanceReducer(B, { type: "MOUTH", shape: "closed", audioPlaying: false });
  }

  /** 假音量源：播放中给一个偏大的音量（口型 open）。 */
  function levelFrame(shape: "closed" | "small" | "open"): void {
    B = performanceReducer(B, { type: "MOUTH", shape, audioPlaying: playing !== null });
  }

  function trySchedule(): void {
    const next = pickNextPlayable(A, ready, playing !== null || silentPending);
    if (!next) return;
    const turnId = A.currentTurnId;
    if (next.silent) {
      dispatchA({ type: "BEAT_AUDIO_STARTED", turnId, seq: next.seq });
      reactionActive = false;
      mouthClosed();
      silentPending = true;
      const seq = next.seq;
      timeline.schedule({
        key: `silent:${turnId}:${seq}`,
        turnId,
        atMs: now + 1_200,
        run: () => {
          silentPending = false;
          dispatchA({ type: "BEAT_AUDIO_ENDED", turnId, seq });
          trySchedule();
        },
      });
      return;
    }
    if (!ready.has(next.seq)) return;
    ready.delete(next.seq);
    playing = { turnId, seq: next.seq };
    dispatchA({ type: "BEAT_AUDIO_STARTED", turnId, seq: next.seq });
    reactionActive = false;
    levelFrame("open");
  }

  const perform = createInterruptExecutor({
    now: () => now,
    stopAudio: () => {
      playing = null;
      silentPending = false;
      reactionActive = false;
      // S6l-fix1 §6：打断同时停掉本地兜底语音。
      localVoiceActive = false;
    },
    forceMouthClosed: mouthClosed,
    cancelTurn: (turnId) => timeline.cancelTurn(turnId),
    clearState: (reason) => dispatchA({ type: reason === "ptt" ? "PTT_DOWN" : "SUBMIT_TEXT" }),
    confirmListening: () => {},
    sendInterrupt: (turnId) => sentInterrupts.push(turnId),
    mark: () => {},
    log: () => {},
    audioPlaying: () => playing !== null,
    reactionActive: () => reactionActive,
    localVoiceActive: () => localVoiceActive,
    mouth: () => B.mouth,
    subtitle: () => A.subtitle,
    oldTurnCommandCount: (turnId) => timelineCountForTurn(timeline.state(), turnId),
    storyCommandCount: () => timelineStoryCount(timeline.state()),
    reportViolations: (list) => violations.push(list),
  } satisfies InterruptDeps);

  function server(message: ServerMessage): void {
    dispatchA({ type: "SERVER_MESSAGE", message });
    if (message.type === "beat" && message.turnId === A.currentTurnId) {
      const storyEventId = message.payload.beat.media?.storyEventId;
      if (storyEventId) C = storyMediaReducer(C, { type: "REQUEST", storyEventId, kind: "photo" });
    }
    if (message.type === "media_ready") {
      const { storyEventId, media, status } = message.payload;
      C = storyMediaReducer(
        C,
        status === "ready"
          ? { type: "READY", storyEventId, media }
          : { type: "FALLBACK", storyEventId, media },
      );
    }
  }

  function assertAudioMouth(): void {
    if (playing === null) expect(B.mouth, "音频不在播放时口型必须是 closed").toBe("closed");
  }

  function interrupt(reason: Reasons): void {
    const turnId = A.currentTurnId;
    if (A.phase.kind === "idle") {
      dispatchA({ type: reason === "ptt" ? "PTT_DOWN" : "SUBMIT_TEXT" });
      return;
    }
    const cameraBefore = A.visual.camera;
    const statusBefore = C.status;
    const violationCountBefore = violations.length;

    perform(reason, turnId);

    // 不变量 1：契约后置条件全部成立。
    expect(violations.length, violations.at(-1)?.join("；")).toBe(violationCountBefore);
    // 不变量 4：镜头不动。
    expect(A.visual.camera).toBe(cameraBefore);
    // 不变量 3：C 不倒退。
    expect(cRank(C.status)).toBeGreaterThanOrEqual(cRank(statusBefore));
    if (statusBefore !== "none") expect(C.status).not.toBe("none");

    // 不变量 2：旧 turnId 的字幕 / 视觉 / 音频事件不再出现。
    const subtitleAfter = A.subtitle;
    const visualAfter = A.visual;
    server(beatMsg(turnId, makeBeat(0, { say: "旧台词", emotion: "sad", camera: "close_up" })));
    server(turnEndMsg(turnId));
    dispatchA({ type: "BEAT_AUDIO_STARTED", turnId, seq: 0 });
    expect(A.subtitle).toBe(subtitleAfter);
    expect(A.visual).toBe(visualAfter);

    // 不变量 5：打断后音频没在播放 → 口型 closed。
    assertAudioMouth();
  }

  return {
    dispatchA,
    server,
    interrupt,
    trySchedule,
    levelFrame,
    advance(ms: number) {
      now += ms;
      timeline.drain();
      assertAudioMouth();
    },
    state: () => ({ A, B, C, playing, reactionActive }),
    sentInterrupts,
    violations,
    // 组合操作（对生成器暴露粗粒度事件；与 controller 的真实行为一致）
    submit() {
      // controller.submitText：idle 时直接提交；否则走打断（会先停音频）。
      if (A.phase.kind === "idle") {
        dispatchA({ type: "SUBMIT_TEXT" });
        reactionActive = true;
      } else {
        interrupt("text");
      }
    },
    pttUp() {
      dispatchA({ type: "PTT_UP" });
      if (A.phase.kind === "thinking") reactionActive = true;
    },
    nudge() {
      // controller.recordNudge：只有 A 为 idle 才主动开口。
      if (A.phase.kind === "idle") dispatchA({ type: "NUDGE" });
    },
    beat(seq: number, media: boolean) {
      server(beatMsg(A.currentTurnId, makeBeat(seq, media ? { media: PHOTO } : {})));
    },
    turnEnd() {
      server(turnEndMsg(A.currentTurnId));
    },
    ttsAudio(seq: number) {
      decoding.add(seq);
    },
    decodeDone(seq: number) {
      decoding.delete(seq);
      ready.add(seq);
      trySchedule();
    },
    playEnd() {
      if (!playing) return;
      const { turnId, seq } = playing;
      playing = null;
      mouthClosed();
      dispatchA({ type: "BEAT_AUDIO_ENDED", turnId, seq });
      trySchedule();
    },
    mediaReady() {
      server({
        ...ENVELOPE,
        type: "media_ready",
        turnId: A.currentTurnId,
        seq: 0,
        payload: { storyEventId: "story-1", media: PHOTO, status: "ready" },
      });
    },
    assertAudioMouth,
  };
}

type Op =
  | "submit"
  | "pttUp"
  | "nudge"
  | "beat0"
  | "beat1"
  | "mediaBeat"
  | "turnEnd"
  | "tts0"
  | "decode0"
  | "tts1"
  | "decode1"
  | "playEnd"
  | "mediaReady"
  | "advance"
  | "interruptPtt"
  | "interruptText";

function apply(sim: ReturnType<typeof createSim>, op: Op): void {
  switch (op) {
    case "submit":
      sim.submit();
      break;
    case "pttUp":
      sim.pttUp();
      break;
    case "nudge":
      sim.nudge();
      break;
    case "beat0":
      sim.beat(0, false);
      break;
    case "beat1":
      sim.beat(1, false);
      break;
    case "mediaBeat":
      sim.beat(0, true);
      break;
    case "turnEnd":
      sim.turnEnd();
      break;
    case "tts0":
      sim.ttsAudio(0);
      break;
    case "decode0":
      sim.decodeDone(0);
      break;
    case "tts1":
      sim.ttsAudio(1);
      break;
    case "decode1":
      sim.decodeDone(1);
      break;
    case "playEnd":
      sim.playEnd();
      break;
    case "mediaReady":
      sim.mediaReady();
      break;
    case "advance":
      sim.advance(500);
      break;
    case "interruptPtt":
      sim.interrupt("ptt");
      break;
    case "interruptText":
      sim.interrupt("text");
      break;
  }
  sim.assertAudioMouth();
}

/** 先进入「正在说话」的可打断状态，让随机打断有东西可打断。 */
const SETUP: Op[] = ["submit", "beat0", "tts0", "decode0"];

const opArb = fc.constantFrom<Op>(
  "submit",
  "pttUp",
  "nudge",
  "beat0",
  "beat1",
  "mediaBeat",
  "turnEnd",
  "tts0",
  "decode0",
  "tts1",
  "decode1",
  "playEnd",
  "mediaReady",
  "advance",
  "interruptPtt",
  "interruptText",
);

const sequenceArb = fc
  .array(opArb, { minLength: 0, maxLength: 18 })
  .map((randomOps): Op[] => [...SETUP, ...randomOps, "interruptPtt"]);

describe("§4 打断矩阵 · 属性测试", () => {
  it("随机交错序列：打断契约与 5 条不变量始终成立（1000 次）", () => {
    fc.assert(
      fc.property(sequenceArb, (ops) => {
        const sim = createSim();
        for (const op of ops) apply(sim, op);
        expect(sim.violations).toEqual([]);
        sim.assertAudioMouth();
      }),
      { numRuns: 1_000 },
    );
  });
});

describe("§4 打断矩阵 · 7 个确定性用例", () => {
  function run(ops: Op[], reason: Reasons) {
    const sim = createSim();
    for (const op of ops) apply(sim, op);
    const before = sim.state();
    sim.interrupt(reason);
    const after = sim.state();
    return { sim, before, after };
  }

  it("1. 思考中打断", () => {
    const { sim, after } = run(["submit"], "ptt");
    expect(after.B.mouth).toBe("closed");
    expect(after.A.subtitle).toBeNull();
    expect(sim.violations).toEqual([]);
  });

  it("2. 反应音播放中打断", () => {
    const sim = createSim();
    sim.submit();
    expect(sim.state().reactionActive).toBe(true); // 反应音已 arm / 在响
    sim.interrupt("ptt");
    expect(sim.state().reactionActive).toBe(false);
    expect(sim.violations).toEqual([]);
  });

  it("3. 一句话说到一半打断（正在播放）", () => {
    const { sim, before, after } = run(SETUP, "ptt");
    expect(before.playing).not.toBeNull();
    expect(after.playing).toBeNull();
    expect(after.B.mouth).toBe("closed");
    expect(after.A.subtitle).toBeNull();
    expect(sim.violations).toEqual([]);
  });

  it("4. 两句之间打断（speaking 但队列里还有下一句未就绪）", () => {
    const { sim, before } = run(["submit", "beat0", "tts0", "decode0", "beat1", "playEnd"], "text");
    // 第一句播完、第二句在队列里但音频未就绪（两句之间）。
    expect(before.playing).toBeNull();
    expect(sim.violations).toEqual([]);
    expect(sim.state().A.subtitle).toBeNull();
  });

  it("5. 解码中打断", () => {
    const { sim } = run(["submit", "beat0", "tts0"], "ptt");
    // tts0 已到达但还没解码完，此时打断。
    expect(sim.violations).toEqual([]);
    expect(sim.state().B.mouth).toBe("closed");
  });

  it("6. 显影中打断：C 保持 developing，不倒退", () => {
    const sim = createSim();
    sim.submit();
    sim.beat(0, true); // 带 media 的 beat → C REQUEST → developing
    expect(sim.state().C.status).toBe("developing");
    sim.interrupt("ptt");
    expect(sim.state().C.status).toBe("developing");
    expect(sim.violations).toEqual([]);
  });

  it("7. 主动开口中打断（nudge 后说话）", () => {
    const sim = createSim();
    sim.nudge();
    sim.beat(0, false);
    sim.ttsAudio(0);
    sim.decodeDone(0); // nudge 后的 beat 开始播放
    expect(sim.state().playing).not.toBeNull();
    sim.interrupt("ptt");
    expect(sim.state().playing).toBeNull();
    expect(sim.violations).toEqual([]);
  });
});
