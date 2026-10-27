import { describe, expect, it } from "vitest";
import {
  INTERRUPT_START_MARK,
  createInterruptExecutor,
  interruptPlan,
  interruptViolations,
  type InterruptDeps,
  type InterruptSnapshot,
} from "../src/core/interrupt";

describe("interruptPlan：有序步骤", () => {
  it("固定 5 步，顺序与打点与 §2 一致", () => {
    const plan = interruptPlan({ reason: "ptt", turnId: 7 });
    expect(plan.map((step) => step.id)).toEqual([
      "audioStopped",
      "mouthClosed",
      "stateCleared",
      "listeningFace",
      "sent",
    ]);
    expect(plan.map((step) => step.mark)).toEqual([
      "interrupt:audioStopped",
      "interrupt:mouthClosed",
      "interrupt:stateCleared",
      "interrupt:faceListening",
      "interrupt:sent",
    ]);
    expect(plan.every((step) => step.turnId === 7)).toBe(true);
  });

  it("原因不影响步骤（清空时 dispatch 什么由外壳决定）", () => {
    expect(interruptPlan({ reason: "text", turnId: 1 }).map((s) => s.id)).toEqual(
      interruptPlan({ reason: "ptt", turnId: 1 }).map((s) => s.id),
    );
  });
});

describe("interruptViolations：契约后置条件", () => {
  const ok: InterruptSnapshot = {
    audioPlaying: false,
    reactionActive: false,
    mouth: "closed",
    subtitle: null,
    oldTurnCommands: 0,
    storyCommands: 2,
    expectedStoryCommands: 2,
  };

  it("全部成立 → 空数组", () => {
    expect(interruptViolations(ok)).toEqual([]);
  });

  it("逐条检测", () => {
    expect(interruptViolations({ ...ok, audioPlaying: true })).toContain("音频仍在播放");
    expect(interruptViolations({ ...ok, reactionActive: true })).toContain("反应音未停止");
    expect(interruptViolations({ ...ok, mouth: "open" })).toContain("口型未闭合");
    expect(interruptViolations({ ...ok, subtitle: "还在说" })).toContain("字幕未清空");
    expect(interruptViolations({ ...ok, oldTurnCommands: 3 })).toContain("旧轮次命令残留 3 条");
    expect(interruptViolations({ ...ok, storyCommands: 1 })).toContain("剧情层命令被改动（2 → 1）");
  });
});

function makeDeps(overrides: Partial<InterruptDeps> = {}) {
  const trace: string[] = [];
  const logs: { t: number; step: string; turnId: number }[] = [];
  const state = { audioPlaying: true, reactionActive: true, mouth: "open" as const, subtitle: "台词" as string | null };
  let now = 0;
  const deps: InterruptDeps = {
    now: () => (now += 1),
    stopAudio: () => {
      trace.push("stopAudio");
      state.audioPlaying = false;
      state.reactionActive = false;
    },
    forceMouthClosed: () => {
      trace.push("forceMouthClosed");
      (state as { mouth: string }).mouth = "closed";
    },
    cancelTurn: (turnId) => trace.push(`cancelTurn:${turnId}`),
    clearState: (reason) => {
      trace.push(`clearState:${reason}`);
      state.subtitle = null;
    },
    confirmListening: () => trace.push("confirmListening"),
    sendInterrupt: (turnId) => trace.push(`sendInterrupt:${turnId}`),
    mark: (name) => trace.push(`mark:${name}`),
    log: (entry) => logs.push(entry),
    audioPlaying: () => state.audioPlaying,
    reactionActive: () => state.reactionActive,
    mouth: () => state.mouth,
    subtitle: () => state.subtitle,
    oldTurnCommandCount: () => 0,
    storyCommandCount: () => 2,
    reportViolations: (violations) => trace.push(`violations:${violations.join("|")}`),
    ...overrides,
  };
  return { deps, trace, logs, state };
}

describe("createInterruptExecutor：同步有序执行", () => {
  it("按计划逐步执行并打点，顺序确定", () => {
    const { deps, trace } = makeDeps();
    const perform = createInterruptExecutor(deps);
    perform("ptt", 7);

    expect(trace).toEqual([
      `mark:${INTERRUPT_START_MARK}`,
      "stopAudio",
      "mark:interrupt:audioStopped",
      "forceMouthClosed",
      "mark:interrupt:mouthClosed",
      "cancelTurn:7",
      "clearState:ptt",
      "mark:interrupt:stateCleared",
      "confirmListening",
      "mark:interrupt:faceListening",
      "sendInterrupt:7",
      "mark:interrupt:sent",
    ]);
  });

  it("每步写 debug 环形缓冲区，带 step 与 turnId", () => {
    const { deps, logs } = makeDeps();
    createInterruptExecutor(deps)("text", 4);
    expect(logs[0]).toEqual({ t: 1, step: "start", turnId: 4 });
    expect(logs.map((entry) => entry.step)).toEqual([
      "start",
      "audioStopped",
      "mouthClosed",
      "stateCleared",
      "listeningFace",
      "sent",
    ]);
  });

  it("后置条件满足时不报违规", () => {
    const { deps, trace } = makeDeps();
    const outcome = createInterruptExecutor(deps)("ptt", 7);
    expect(outcome.violations).toEqual([]);
    expect(trace.some((entry) => entry.startsWith("violations:"))).toBe(false);
  });

  it("后置条件被违反时 reportViolations 收到具体违规项", () => {
    // 不闭嘴、不停止音频：模拟执行器漏了步骤。
    const { deps, trace } = makeDeps({
      forceMouthClosed: () => {},
      stopAudio: () => {},
    });
    const outcome = createInterruptExecutor(deps)("ptt", 7);
    expect(outcome.violations).toContain("音频仍在播放");
    expect(outcome.violations).toContain("口型未闭合");
    expect(trace.some((entry) => entry.startsWith("violations:"))).toBe(true);
  });

  it("剧情层命令数在任何情况下都必须保持", () => {
    // 第一次读（执行前）为 2，之后（执行后）变成 1 → 判定为剧情层被改动。
    let calls = 0;
    const { deps } = makeDeps({ storyCommandCount: () => (calls++ === 0 ? 2 : 1) });
    const outcome = createInterruptExecutor(deps)("ptt", 7);
    expect(outcome.violations).toContain("剧情层命令被改动（2 → 1）");
  });
});
