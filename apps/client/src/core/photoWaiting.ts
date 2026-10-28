import { getStageState, useStageStore } from "./store";
import { timeline, type Timeline } from "./timeline";
import { useStoryMediaStore } from "./storyMediaLink";
import {
  PHOTO_WAITING_FIRST_MS,
  PHOTO_WAITING_INTERVAL_MS,
  PHOTO_WAITING_MAX,
  photoWaitingDecision,
} from "../state/photoWaiting";
import type { StagePhaseKind } from "../state/performance";

/**
 * freeze-fix3 §1：截图等待期「边翻边聊」铺垫的浏览器外壳。
 *
 * 纯函数 `state/photoWaiting.photoWaitingDecision` 只判「此刻是否该发」；
 * 这里负责：观察 C 的照片槽位进入 `developing`、A 回到 idle 的时机，
 * 用统一时间线按 1.5s（首次）/ 10s（后续）排一次铺垫 nudge，每个截图事件最多 3 次。
 *
 * 停止：截图就绪 / 失败（照片槽位离开 `developing`）、用户开口 / 打断（A 离开 idle）、
 * 或该事件已达 3 次。时间线命令以 `photo-waiting:<storyEventId>` 为 key，同 key 只保留最新一条。
 */

/** 调度器只需观察「当前照片槽位状态」与「A 的 phase」。 */
export type PhotoWaitingSource = {
  photoStatus: () => { status: string; storyEventId: string | null };
  phase: () => StagePhaseKind;
};

export type PhotoWaitingDeps = {
  now: () => number;
  onNudge: (at: number) => void;
  timeline: Pick<Timeline, "schedule" | "cancelKey">;
  source: PhotoWaitingSource;
};

export type PhotoWaitingScheduler = {
  /** 外部（订阅回调 / 时间线到点）驱动：重算并起排。 */
  evaluate: () => void;
  /** 该截图事件已经铺垫过几次（便于测试断言）。 */
  firedCount: (storyEventId: string) => number;
};

function commandKey(storyEventId: string): string {
  return `photo-waiting:${storyEventId}`;
}

/**
 * 纯逻辑外壳：把「是否发」的判定接到时间线。不直接订阅 store，由调用方驱动 `evaluate`。
 * 每来一次 evaluate，就按当前状态决定是否（重新）排一次尝试。
 */
export function createPhotoWaitingScheduler(deps: PhotoWaitingDeps): PhotoWaitingScheduler {
  /** 每个截图事件：已铺垫次数、上次铺垫时刻、A 进入本轮 idle 的时刻。 */
  const fired = new Map<string, number>();
  const lastAt = new Map<string, number>();
  const idleSince = new Map<string, number>();
  let currentKey: string | null = null;

  const forget = (id: string): void => {
    fired.delete(id);
    lastAt.delete(id);
    idleSince.delete(id);
  };

  const stop = (): void => {
    if (currentKey !== null) deps.timeline.cancelKey(commandKey(currentKey));
    if (currentKey !== null) forget(currentKey);
    currentKey = null;
  };

  const schedule = (storyEventId: string): void => {
    if (deps.source.phase() !== "idle") return;
    if (deps.source.photoStatus().storyEventId !== storyEventId) return;
    if (deps.source.photoStatus().status !== "developing") return;

    const count = fired.get(storyEventId) ?? 0;
    if (count >= PHOTO_WAITING_MAX) return;

    const now = deps.now();
    idleSince.set(storyEventId, idleSince.get(storyEventId) ?? now);
    const delay = count === 0 ? PHOTO_WAITING_FIRST_MS : PHOTO_WAITING_INTERVAL_MS;

    deps.timeline.schedule({
      key: commandKey(storyEventId),
      atMs: now + delay,
      run: () => {
        const snapshot = deps.source.photoStatus();
        // 事件已切换 / 已就绪 / 失败：停止该事件的计划。
        if (snapshot.storyEventId !== storyEventId || snapshot.status !== "developing") {
          if (currentKey === storyEventId) {
            forget(storyEventId);
            currentKey = null;
          }
          return;
        }
        const at = deps.now();
        const decision = photoWaitingDecision({
          phase: deps.source.phase(),
          photoStatus: "developing",
          fired: fired.get(storyEventId) ?? 0,
          sinceIdleMs: at - (idleSince.get(storyEventId) ?? at),
          sinceLastMs: lastAt.has(storyEventId) ? at - (lastAt.get(storyEventId) ?? at) : null,
        });
        if (!decision.send) return;
        fired.set(storyEventId, (fired.get(storyEventId) ?? 0) + 1);
        lastAt.set(storyEventId, at);
        deps.onNudge(at);
        // 刚发过且未达上限 → 排下一次（10s 间隔，同 key 覆盖）。
        schedule(storyEventId);
      },
    });
  };

  return {
    evaluate() {
      const snapshot = deps.source.photoStatus();
      if (snapshot.status !== "developing" || snapshot.storyEventId === null) {
        stop();
        return;
      }
      if (snapshot.storyEventId !== currentKey) {
        stop();
        currentKey = snapshot.storyEventId;
      }
      // 只有 A 在 idle 才起排；否则等回 idle（下次 evaluate）。
      if (deps.source.phase() !== "idle") return;
      schedule(snapshot.storyEventId);
    },
    firedCount(storyEventId: string): number {
      return fired.get(storyEventId) ?? 0;
    },
  };
}

let installedCleanup: (() => void) | null = null;

/** 浏览器接线：订阅 C 的照片槽位与 A 的 phase，驱动调度器。幂等。 */
export function installPhotoWaiting(deps: { now: () => number; onNudge: (at: number) => void }): () => void {
  if (installedCleanup) return installedCleanup;
  const scheduler = createPhotoWaitingScheduler({
    now: deps.now,
    onNudge: deps.onNudge,
    timeline,
    source: {
      photoStatus: () => {
        const state = useStoryMediaStore.getState();
        return { status: state.status, storyEventId: state.storyEventId };
      },
      phase: () => getStageState().phase.kind,
    },
  });

  let lastPhase: StagePhaseKind = getStageState().phase.kind;
  let lastStatus = useStoryMediaStore.getState().status;
  const unsubStage = useStageStore.subscribe((state) => {
    if (state.phase.kind === lastPhase) return;
    lastPhase = state.phase.kind;
    if (state.phase.kind === "idle") scheduler.evaluate();
  });
  const unsubMedia = useStoryMediaStore.subscribe((state) => {
    if (state.status === lastStatus) return;
    lastStatus = state.status;
    scheduler.evaluate();
  });
  scheduler.evaluate();

  installedCleanup = () => {
    unsubStage();
    unsubMedia();
    installedCleanup = null;
  };
  return installedCleanup;
}
