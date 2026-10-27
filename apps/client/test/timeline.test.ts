import { describe, expect, it, beforeEach } from "vitest";
import {
  clearTimelineLog,
  createTimeline,
  emptyTimelineState,
  timelineAdd,
  timelineCancelTurn,
  timelineCountForTurn,
  timelineDue,
  timelineLog,
  timelineNextAt,
  timelineStoryCount,
  type TimelineCommand,
  type TimelineState,
} from "../src/core/timeline";

function command(id: number, atMs: number, overrides: Partial<TimelineCommand> = {}): TimelineCommand {
  return { id, key: `k${id}`, atMs, run: () => {}, ...overrides };
}

describe("timeline：纯数据结构", () => {
  it("timelineAdd 追加命令", () => {
    const state = timelineAdd(timelineAdd(emptyTimelineState, command(1, 100)), command(2, 50));
    expect(state.commands.map((c) => c.id)).toEqual([1, 2]);
  });

  it("timelineCancelTurn 只取消该轮次、且不带 storyEventId 的命令", () => {
    const state: TimelineState = {
      commands: [
        command(1, 100, { turnId: 7 }),
        command(2, 200, { turnId: 7, storyEventId: "s1" }),
        command(3, 300, { turnId: 8 }),
        command(4, 400, {}),
      ],
    };
    const cancelled = timelineCancelTurn(state, 7);
    expect(cancelled.commands.map((c) => c.id)).toEqual([2, 3, 4]);
  });

  it("timelineDue 取出到点命令（先按 atMs 再按 id），其余保留", () => {
    const state: TimelineState = {
      commands: [command(2, 50), command(1, 50), command(3, 500)],
    };
    const { due, state: rest } = timelineDue(state, 100);
    expect(due.map((c) => c.id)).toEqual([1, 2]);
    expect(rest.commands.map((c) => c.id)).toEqual([3]);
  });

  it("timelineDue 无到点命令时返回同一个 state 引用", () => {
    const state: TimelineState = { commands: [command(1, 500)] };
    const result = timelineDue(state, 100);
    expect(result.due).toEqual([]);
    expect(result.state).toBe(state);
  });

  it("timelineNextAt / timelineCountForTurn / timelineStoryCount", () => {
    const state: TimelineState = {
      commands: [command(1, 300, { turnId: 7 }), command(2, 100, { turnId: 7, storyEventId: "s1" }), command(3, 200, { turnId: 8 })],
    };
    expect(timelineNextAt(state)).toBe(100);
    expect(timelineNextAt(emptyTimelineState)).toBeNull();
    expect(timelineCountForTurn(state, 7)).toBe(1);
    expect(timelineStoryCount(state)).toBe(1);
  });
});

function makeShell() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { cb: () => void }>();
  const timeline = createTimeline({
    now: () => now,
    setTimer: (cb) => {
      seq += 1;
      pending.set(seq, { cb });
      return seq;
    },
    clearTimer: (id) => {
      pending.delete(id);
    },
  });
  return {
    timeline,
    pending,
    setNow(value: number) {
      now = value;
    },
    /** 触发当前挂起的定时器（若最近一条命令到点）。 */
    fireTimer() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) entry.cb();
    },
    pendingCount: () => pending.size,
  };
}

describe("timeline 外壳：单个定时器驱动", () => {
  let fired: string[];
  beforeEach(() => {
    fired = [];
    clearTimelineLog();
  });

  it("只有一个定时器：注册多条命令后挂起的定时器数量不超过 1", () => {
    const shell = makeShell();
    shell.timeline.schedule({ key: "a", atMs: 100, run: () => fired.push("a") });
    shell.timeline.schedule({ key: "b", atMs: 500, run: () => fired.push("b") });
    expect(shell.pendingCount()).toBe(1);
    expect(shell.timeline.nextAt()).toBe(100);
  });

  it("到点才执行；同 key 只保留最新一条", () => {
    const shell = makeShell();
    shell.timeline.schedule({ key: "nudge", atMs: 100, run: () => fired.push("first") });
    shell.timeline.schedule({ key: "nudge", atMs: 200, run: () => fired.push("second") });
    shell.setNow(150);
    shell.fireTimer();
    expect(fired).toEqual([]);
    shell.setNow(250);
    shell.fireTimer();
    expect(fired).toEqual(["second"]);
  });

  it("cancelTurn 取消该轮次命令，但保留带 storyEventId 的剧情层命令", () => {
    const shell = makeShell();
    shell.timeline.schedule({ key: "a", turnId: 7, atMs: 100, run: () => fired.push("turn7") });
    shell.timeline.schedule({ key: "s", turnId: 7, storyEventId: "story-1", atMs: 100, run: () => fired.push("story") });
    shell.timeline.cancelTurn(7);
    shell.setNow(1_000);
    shell.fireTimer();
    expect(fired).toEqual(["story"]);
  });

  it("cancelId / cancelKey 移除命令", () => {
    const shell = makeShell();
    const id = shell.timeline.schedule({ key: "x", atMs: 100, run: () => fired.push("x") });
    shell.timeline.cancelId(id);
    shell.timeline.schedule({ key: "y", atMs: 100, run: () => fired.push("y") });
    shell.timeline.cancelKey("y");
    shell.setNow(1_000);
    shell.fireTimer();
    expect(fired).toEqual([]);
  });

  it("写入 debug 环形缓冲区：scheduled / fired / cancelled", () => {
    const shell = makeShell();
    const id = shell.timeline.schedule({ key: "a", turnId: 3, atMs: 100, run: () => fired.push("a") });
    shell.timeline.cancelId(id);
    const kinds = timelineLog().map((entry) => entry.kind);
    expect(kinds).toEqual(["scheduled", "cancelled"]);
    expect(timelineLog()[0]?.turnId).toBe(3);
  });
});
