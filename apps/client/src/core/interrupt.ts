/**
 * 打断有序执行器（D34 落地方案 · 有序 · 契约式设计）。
 *
 * 为什么不是一个订阅者广播：observer-pattern 只在「对事件顺序要求严格时」会被否决
 * （它的 When NOT）。打断必须在**同一帧内**、**按确定顺序**完成，所以改成显式执行器。
 *
 * - `interruptPlan(state)`：纯函数，只描述「该做什么」，不执行任何副作用；
 * - `interruptViolations(snapshot)`：纯函数，检查 D34 契约的后置条件；
 * - `createInterruptExecutor(deps)`：外壳，按计划**同步**执行，每步打 `performance.mark`
 *   并写 debug 环形缓冲区，最后断言后置条件（违反则 console.error + 写日志）。
 */
import type { MouthShape } from "../state/performance";

export type InterruptReason = "ptt" | "text" | "tap";

export type InterruptPlanInput = {
  reason: InterruptReason;
  /** 被打断的旧轮次。 */
  turnId: number;
};

export type InterruptStepId = "audioStopped" | "mouthClosed" | "stateCleared" | "listeningFace" | "sent";

export type InterruptStep = {
  id: InterruptStepId;
  /** 该步完成后打点的名字。 */
  mark: string;
  turnId: number;
};

/** 第 1 步（在任何实际动作之前）的打点。 */
export const INTERRUPT_START_MARK = "interrupt:start";

export const INTERRUPT_MARKS: Record<InterruptStepId, string> = {
  audioStopped: "interrupt:audioStopped",
  mouthClosed: "interrupt:mouthClosed",
  stateCleared: "interrupt:stateCleared",
  listeningFace: "interrupt:faceListening",
  sent: "interrupt:sent",
};

/**
 * 有序步骤（§2）：停止音频与反应音 → 闭嘴 → 清空时间线与字幕 → 切倾听（B 由 phase 推导）→ 发 interrupt。
 * 纯函数：只返回步骤清单；`reason` 决定清空状态时 dispatch PTT_DOWN 还是 SUBMIT_TEXT（由外壳做）。
 */
export function interruptPlan(input: InterruptPlanInput): InterruptStep[] {
  return [
    { id: "audioStopped", mark: INTERRUPT_MARKS.audioStopped, turnId: input.turnId },
    { id: "mouthClosed", mark: INTERRUPT_MARKS.mouthClosed, turnId: input.turnId },
    { id: "stateCleared", mark: INTERRUPT_MARKS.stateCleared, turnId: input.turnId },
    { id: "listeningFace", mark: INTERRUPT_MARKS.listeningFace, turnId: input.turnId },
    { id: "sent", mark: INTERRUPT_MARKS.sent, turnId: input.turnId },
  ];
}

/** 契约后置条件（执行完毕的同一帧内必须成立）的快照。 */
export type InterruptSnapshot = {
  audioPlaying: boolean;
  reactionActive: boolean;
  /** S6l-fix1 §6：本地兜底语音是否还在响。 */
  localVoiceActive: boolean;
  mouth: MouthShape;
  subtitle: string | null;
  /** 旧 turnId 在时间线里剩余的命令数。 */
  oldTurnCommands: number;
  /** 时间线里剧情层命令数（打断前后都要相等）。 */
  storyCommands: number;
  expectedStoryCommands: number;
};

/** 返回被违反的后置条件（空数组 = 全部成立）。纯函数，便于单测与属性测试。 */
export function interruptViolations(snapshot: InterruptSnapshot): string[] {
  const violations: string[] = [];
  if (snapshot.audioPlaying) violations.push("音频仍在播放");
  if (snapshot.reactionActive) violations.push("反应音未停止");
  if (snapshot.localVoiceActive) violations.push("本地兜底语音未停止");
  if (snapshot.mouth !== "closed") violations.push("口型未闭合");
  if (snapshot.subtitle !== null) violations.push("字幕未清空");
  if (snapshot.oldTurnCommands !== 0) violations.push(`旧轮次命令残留 ${snapshot.oldTurnCommands} 条`);
  if (snapshot.storyCommands !== snapshot.expectedStoryCommands) {
    violations.push(`剧情层命令被改动（${snapshot.expectedStoryCommands} → ${snapshot.storyCommands}）`);
  }
  return violations;
}

/** 打断执行完毕后由外壳读到的可观测状态。 */
export type InterruptDeps = {
  now: () => number;
  /** 停止音频源并同时停止反应音；必须幂等。 */
  stopAudio: () => void;
  /** 强制口型为 closed。 */
  forceMouthClosed: () => void;
  /** 取消旧轮次在时间线上的全部命令。 */
  cancelTurn: (turnId: number) => void;
  /** dispatch PTT_DOWN 或 SUBMIT_TEXT（reducer 会清空字幕与队列）。 */
  clearState: (reason: InterruptReason) => void;
  /** 确认倾听表情 / 手部收回（B 由 phase 推导，外壳只需确认）。 */
  confirmListening: () => void;
  /** 发送 interrupt 给服务端。 */
  sendInterrupt: (turnId: number) => void;
  /** performance.mark（可空实现）。 */
  mark: (name: string) => void;
  /** 写 debug 环形缓冲区：{t, step, turnId}。 */
  log: (entry: { t: number; step: string; turnId: number }) => void;
  audioPlaying: () => boolean;
  reactionActive: () => boolean;
  /** S6l-fix1 §6：本地兜底语音是否在响。 */
  localVoiceActive: () => boolean;
  mouth: () => MouthShape;
  subtitle: () => string | null;
  oldTurnCommandCount: (turnId: number) => number;
  storyCommandCount: () => number;
  /** 开发模式：违反后置条件时 console.error + 写日志；生产可注入空实现。 */
  reportViolations: (violations: string[], turnId: number) => void;
};

export type InterruptOutcome = {
  reason: InterruptReason;
  turnId: number;
  violations: string[];
};

export type PerformInterrupt = (reason: InterruptReason, turnId: number) => InterruptOutcome;

/** 外壳：按 `interruptPlan` 同步执行、逐步打点与记录，最后校验后置条件。 */
export function createInterruptExecutor(deps: InterruptDeps): PerformInterrupt {
  return (reason, turnId) => {
    // 剧情层命令在打断前的数量：执行完毕后必须原样保留。
    const expectedStoryCommands = deps.storyCommandCount();

    deps.mark(INTERRUPT_START_MARK);
    deps.log({ t: deps.now(), step: "start", turnId });

    for (const step of interruptPlan({ reason, turnId })) {
      switch (step.id) {
        case "audioStopped":
          deps.stopAudio();
          break;
        case "mouthClosed":
          deps.forceMouthClosed();
          break;
        case "stateCleared":
          deps.cancelTurn(turnId);
          deps.clearState(reason);
          break;
        case "listeningFace":
          deps.confirmListening();
          break;
        case "sent":
          deps.sendInterrupt(turnId);
          break;
      }
      deps.mark(step.mark);
      deps.log({ t: deps.now(), step: step.id, turnId });
    }

    const snapshot: InterruptSnapshot = {
      audioPlaying: deps.audioPlaying(),
      reactionActive: deps.reactionActive(),
      localVoiceActive: deps.localVoiceActive(),
      mouth: deps.mouth(),
      subtitle: deps.subtitle(),
      oldTurnCommands: deps.oldTurnCommandCount(turnId),
      storyCommands: deps.storyCommandCount(),
      expectedStoryCommands,
    };
    const violations = interruptViolations(snapshot);
    if (violations.length > 0) deps.reportViolations(violations, turnId);
    return { reason, turnId, violations };
  };
}
