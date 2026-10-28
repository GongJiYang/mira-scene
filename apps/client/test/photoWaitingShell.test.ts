import { describe, expect, it } from "vitest";
import { createPhotoWaitingScheduler, type PhotoWaitingSource } from "../src/core/photoWaiting";
import {
  PHOTO_WAITING_FIRST_MS,
  PHOTO_WAITING_INTERVAL_MS,
} from "../src/state/photoWaiting";
import type { TimelineCommand } from "../src/core/timeline";

/**
 * freeze-fix3 §1/§4：铺垫调度外壳——接到假时间线上，验证 1.5s / 10s / 上限 3 / 就绪即停 / 非 idle 不发。
 */
function harness() {
  let now = 0;
  const scheduled = new Map<string, TimelineCommand>();
  const nudges: number[] = [];
  let status: { status: string; storyEventId: string | null } = { status: "developing", storyEventId: "s:2:0" };
  let phase: "idle" | "listening" | "thinking" | "speaking" | "error" = "idle";

  const source: PhotoWaitingSource = {
    photoStatus: () => status,
    phase: () => phase,
  };
  const scheduler = createPhotoWaitingScheduler({
    now: () => now,
    onNudge: (at) => nudges.push(at),
    timeline: {
      schedule: (command) => {
        scheduled.set(command.key, command as TimelineCommand);
        return 1;
      },
      cancelKey: (key) => {
        scheduled.delete(key);
      },
    },
    source,
  });

  return {
    scheduler,
    nudges,
    scheduled,
    /** 推进到某时刻并执行所有到点命令（模拟时间线到点）。 */
    advanceTo(at: number) {
      now = at;
      for (const [key, command] of [...scheduled]) {
        if (command.atMs <= at) {
          scheduled.delete(key);
          command.run();
        }
      }
    },
    setPhase(next: typeof phase) {
      phase = next;
    },
    setStatus(next: typeof status) {
      status = next;
    },
    setNow(at: number) {
      now = at;
    },
  };
}

describe("createPhotoWaitingScheduler（§1）", () => {
  it("idle + 截图 developing：首次在 1.5s 后铺垫", () => {
    const h = harness();
    h.scheduler.evaluate();
    const command = [...h.scheduled.values()][0];
    expect(command?.atMs).toBe(PHOTO_WAITING_FIRST_MS);

    h.advanceTo(PHOTO_WAITING_FIRST_MS);
    expect(h.nudges).toHaveLength(1);
  });

  it("之后每隔 10s 再插一次，每个截图事件最多 3 次", () => {
    const h = harness();
    h.scheduler.evaluate();

    h.advanceTo(PHOTO_WAITING_FIRST_MS); // #1
    h.advanceTo(PHOTO_WAITING_FIRST_MS + PHOTO_WAITING_INTERVAL_MS); // #2
    h.advanceTo(PHOTO_WAITING_FIRST_MS + 2 * PHOTO_WAITING_INTERVAL_MS); // #3
    expect(h.nudges).toHaveLength(3);

    // 上限后不再排下一次。
    h.advanceTo(PHOTO_WAITING_FIRST_MS + 10 * PHOTO_WAITING_INTERVAL_MS);
    expect(h.nudges).toHaveLength(3);
    expect(h.scheduled.size).toBe(0);
  });

  it("截图就绪（离开 developing）：立即停止剩余计划", () => {
    const h = harness();
    h.scheduler.evaluate();
    h.advanceTo(PHOTO_WAITING_FIRST_MS); // #1
    expect(h.nudges).toHaveLength(1);

    h.setStatus({ status: "ready", storyEventId: "s:2:0" });
    h.scheduler.evaluate();
    expect(h.scheduled.size).toBe(0);

    h.advanceTo(PHOTO_WAITING_FIRST_MS + 5 * PHOTO_WAITING_INTERVAL_MS);
    expect(h.nudges).toHaveLength(1);
  });

  it("A 不是 idle 时不发（首次不排）", () => {
    const h = harness();
    h.setPhase("speaking");
    h.scheduler.evaluate();
    expect(h.scheduled.size).toBe(0);
    expect(h.nudges).toHaveLength(0);
  });

  it("A 从说话回到 idle 后重新起排", () => {
    const h = harness();
    h.setPhase("speaking");
    h.scheduler.evaluate();
    expect(h.scheduled.size).toBe(0);

    h.setPhase("idle");
    h.setNow(50_000);
    h.scheduler.evaluate();
    const command = [...h.scheduled.values()][0];
    expect(command?.atMs).toBe(50_000 + PHOTO_WAITING_FIRST_MS);
  });
});
