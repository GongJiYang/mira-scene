/**
 * 可取消的时间线调度器（D34 落地方案 · command-pattern）。
 *
 * 函数式核心（纯数据结构，写单测）：
 *   - `timelineAdd(state, command)`：入队；
 *   - `timelineCancelTurn(state, turnId)`：取消该轮次的全部命令；
 *   - `timelineDue(state, nowMs)`：取出到点的命令并返回剩余队列。
 *
 * 命令式外壳（`createTimeline`）：所有这些延时事件（无声 beat 停留、反应音淡出、
 * 表演时钟节拍、nudge 计时）都注册到**同一个**时间线，由**单个**定时器驱动。
 *
 * 契约（§3）：
 *   - `cancelTurn(turnId)` 取消该 turnId 下的全部命令；
 *   - 带 `storyEventId` 的命令不受 `cancelTurn` 影响（剧情层事件跨轮存活，D27）。
 *
 * 事件日志只写进 debug 环形缓冲区（scheduled / fired / cancelled），不画 UI（YAGNI）。
 */

export type TimelineCommand = {
  /** 命令 id，由外壳分配。 */
  id: number;
  /** 调试用的稳定键（如 `reaction` / `silent:3:0` / `nudge`）。 */
  key: string;
  /** 归属轮次；打断时按它整批取消。 */
  turnId?: number;
  /** 剧情层命令（D27）：不与轮次绑定，`cancelTurn` 不取消它。 */
  storyEventId?: string;
  /** 绝对触发时刻（与外壳 `now()` 同一时钟）。 */
  atMs: number;
  /** 到点后由外壳执行的副作用。 */
  run: () => void;
};

export type TimelineState = {
  commands: readonly TimelineCommand[];
};

export const emptyTimelineState: TimelineState = { commands: [] };

/** 入队：同一 key 不必去重（由调用方决定是否先 cancelKey）。 */
export function timelineAdd(state: TimelineState, command: TimelineCommand): TimelineState {
  return { commands: [...state.commands, command] };
}

function isCancelledByTurn(command: TimelineCommand, turnId: number): boolean {
  return command.turnId === turnId && command.storyEventId === undefined;
}

/** 取消某轮次的全部命令；带 storyEventId 的命令保留（剧情层例外）。 */
export function timelineCancelTurn(state: TimelineState, turnId: number): TimelineState {
  const commands = state.commands.filter((command) => !isCancelledByTurn(command, turnId));
  return commands.length === state.commands.length ? state : { commands };
}

/** 取出到点的命令（按 atMs 再按 id 升序），剩余队列同步返回。 */
export function timelineDue(state: TimelineState, nowMs: number): { due: TimelineCommand[]; state: TimelineState } {
  const due: TimelineCommand[] = [];
  const rest: TimelineCommand[] = [];
  for (const command of state.commands) {
    if (command.atMs <= nowMs) due.push(command);
    else rest.push(command);
  }
  if (due.length === 0) return { due, state };
  due.sort((left, right) => left.atMs - right.atMs || left.id - right.id);
  return { due, state: { commands: rest } };
}

/** 最近一个到点时刻；没有命令时为 null（外壳据此决定定时器时长）。 */
export function timelineNextAt(state: TimelineState): number | null {
  let next: number | null = null;
  for (const command of state.commands) {
    if (next === null || command.atMs < next) next = command.atMs;
  }
  return next;
}

/** 某轮次下还剩多少命令（打断后置条件：旧轮次命令数为 0）。 */
export function timelineCountForTurn(state: TimelineState, turnId: number): number {
  let count = 0;
  for (const command of state.commands) if (command.turnId === turnId && command.storyEventId === undefined) count += 1;
  return count;
}

/** 剧情层命令总数（打断后置条件：全部保留）。 */
export function timelineStoryCount(state: TimelineState): number {
  let count = 0;
  for (const command of state.commands) if (command.storyEventId !== undefined) count += 1;
  return count;
}

/** debug 环形缓冲区条目（只写日志，不做 UI）。 */
export type TimelineLogKind = "scheduled" | "fired" | "cancelled" | "interrupt";

export type TimelineLogEntry = {
  t: number;
  kind: TimelineLogKind;
  key: string;
  turnId?: number;
  storyEventId?: string;
};

const MAX_LOG = 200;
let log: TimelineLogEntry[] = [];

export function pushTimelineLog(entry: TimelineLogEntry): void {
  log = [...log, entry].slice(-MAX_LOG);
}

export function timelineLog(): readonly TimelineLogEntry[] {
  return log;
}

export function clearTimelineLog(): void {
  log = [];
}

export type TimelineDeps = {
  now: () => number;
  setTimer: (callback: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  onLog?: (entry: TimelineLogEntry) => void;
};

export type Timeline = {
  /** 注册一条命令，返回命令 id（可用于 `cancelId`）。 */
  schedule(command: Omit<TimelineCommand, "id">): number;
  cancelId(id: number): void;
  cancelKey(key: string): void;
  cancelTurn(turnId: number): void;
  /** 由定时器回调触发：执行所有到点命令，并重排下一个定时器。 */
  runDue(): void;
  /** 立即取出并执行到点命令（测试/帧内推进用）。 */
  drain(nowMs?: number): TimelineCommand[];
  nextAt(): number | null;
  /** 外壳时钟（与 `atMs` 同一来源），便于调用方计算相对时刻。 */
  now(): number;
  state(): TimelineState;
  reset(): void;
};

/**
 * 命令式外壳：内部只维护**一个**定时器，永远指向最近一个命令的到点时刻。
 * 定时器与时钟都注入，因此可脱离浏览器单测。
 */
export function createTimeline(deps: TimelineDeps): Timeline {
  let state = emptyTimelineState;
  let nextId = 1;
  let timer: number | null = null;

  function emit(entry: TimelineLogEntry): void {
    pushTimelineLog(entry);
    deps.onLog?.(entry);
  }

  function clearPendingTimer(): void {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  }

  function scheduleNextTimer(): void {
    clearPendingTimer();
    const at = timelineNextAt(state);
    if (at === null) return;
    const wait = Math.max(0, at - deps.now());
    timer = deps.setTimer(() => {
      timer = null;
      runDue();
    }, wait);
  }

  function runDue(): void {
    const now = deps.now();
    const { due, state: rest } = timelineDue(state, now);
    state = rest;
    for (const command of due) {
      emit({ t: now, kind: "fired", key: command.key, turnId: command.turnId, storyEventId: command.storyEventId });
      command.run();
    }
    scheduleNextTimer();
  }

  return {
    schedule(command) {
      const id = nextId;
      nextId += 1;
      // 同 key 的命令只保留最新一条（如重排反应音、重排 nudge）。
      state = { commands: state.commands.filter((existing) => existing.key !== command.key) };
      state = timelineAdd(state, { ...command, id });
      emit({ t: deps.now(), kind: "scheduled", key: command.key, turnId: command.turnId, storyEventId: command.storyEventId });
      scheduleNextTimer();
      return id;
    },

    cancelId(id) {
      const target = state.commands.find((command) => command.id === id);
      if (!target) return;
      state = { commands: state.commands.filter((command) => command.id !== id) };
      emit({ t: deps.now(), kind: "cancelled", key: target.key, turnId: target.turnId, storyEventId: target.storyEventId });
      scheduleNextTimer();
    },

    cancelKey(key) {
      const removed = state.commands.filter((command) => command.key === key);
      if (removed.length === 0) return;
      state = { commands: state.commands.filter((command) => command.key !== key) };
      for (const command of removed) {
        emit({ t: deps.now(), kind: "cancelled", key: command.key, turnId: command.turnId, storyEventId: command.storyEventId });
      }
      scheduleNextTimer();
    },

    cancelTurn(turnId) {
      const removed = state.commands.filter((command) => isCancelledByTurn(command, turnId));
      if (removed.length === 0) return;
      state = timelineCancelTurn(state, turnId);
      for (const command of removed) {
        emit({ t: deps.now(), kind: "cancelled", key: command.key, turnId: command.turnId });
      }
      scheduleNextTimer();
    },

    runDue,

    drain(nowMs) {
      const now = nowMs ?? deps.now();
      const { due, state: rest } = timelineDue(state, now);
      state = rest;
      for (const command of due) {
        emit({ t: now, kind: "fired", key: command.key, turnId: command.turnId, storyEventId: command.storyEventId });
        command.run();
      }
      scheduleNextTimer();
      return due;
    },

    nextAt() {
      return timelineNextAt(state);
    },

    now() {
      return deps.now();
    },

    state() {
      return state;
    },

    reset() {
      clearPendingTimer();
      state = emptyTimelineState;
      nextId = 1;
    },
  };
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function defaultSetTimer(callback: () => void, ms: number): number {
  return globalThis.setTimeout(callback, ms) as unknown as number;
}

function defaultClearTimer(id: number): void {
  globalThis.clearTimeout(id);
}

/** 全局唯一的时间线（应用里所有延时事件共用这一个，达成「单个定时器」）。 */
export const timeline: Timeline = createTimeline({ now: defaultNow, setTimer: defaultSetTimer, clearTimer: defaultClearTimer });
