/**
 * S6c §4：换背景任务状态机（纯函数 reducer）。
 *
 * 状态：`idle → writing → generating → ready | failed`；另有 `busy`（冷却中/超次数时不发起）。
 * 同一会话同时只允许一个任务；成功或失败后冷却 45 秒；每会话最多 5 次。
 * 冷却中或超次数再请求 → 不发起，角色用 `scene_busy` 台词回应。
 *
 * 本模块只做状态转移与规则判定，不做 I/O。
 */

/** S6c §4：任务状态。 */
export type SceneJobStatus = "idle" | "writing" | "generating" | "ready" | "failed" | "busy";

/** S6c §4：任务记录。 */
export type SceneJob = {
  jobId: string;
  status: SceneJobStatus;
  /** 扩写成功时的场景 label（用于状态条与 `scene_notes`）。 */
  label?: string;
  /** 两张图都就绪后的可访问地址（desktop / mobile）。 */
  urls?: { desktop: string; mobile: string };
  /** 失败原因（`failed` 时）。 */
  error?: string;
  /** 任务开始时间（服务端时钟，毫秒）。 */
  startedAt: number;
  /** 状态变化时间（服务端时钟，毫秒）。 */
  updatedAt: number;
};

/** S6c §4：会话级换背景状态（ reducer 的输入）。 */
export type SceneJobState = {
  /** 当前任务（同时只允许一个）。 */
  current: SceneJob | null;
  /** 已发起的任务数（每会话最多 5 次）。 */
  used: number;
  /** S6c §5：上一次任务结束（ready / failed）时间（冷却 45 秒）。 */
  lastFinishedAt: number | null;
  /**
   * S6l-fix2 §5：一次性提示——「背景已经换成 X」，只在下一轮 `scene_notes` 用一次，用完清空。
   * 与「当前背景」解耦，避免提示用完把当前背景名一起丢掉。
   */
  pendingReadyNote?: string;
  /**
   * S6l-fix2 §5：当前正在显示的生成背景（持久，换成功时覆盖）。刷新恢复、参考图、
   * 扩写器的 `currentScene` 都读这里；没换过为 undefined（用角色包默认背景）。
   */
  currentBackground?: { label: string; urls: { desktop: string; mobile: string } };
  /** S6c-fix1 §2：上一次任务失败 / 被拒（用于下一轮 scene_notes 提一句「刚才背景没换成」）。 */
  lastFailed?: boolean;
};

/** S6c §4：初始状态。 */
export function initialSceneJobState(): SceneJobState {
  return { current: null, used: 0, lastFinishedAt: null };
}

/** S6c §4：冷却时长（毫秒）。 */
export const SCENE_COOLDOWN_MS = 45_000;
/** S6c §4：每会话最多任务数。 */
export const SCENE_MAX_JOBS = 5;
/** S6c §4：从发起到两张图都就绪的超时（毫秒）。 */
export const SCENE_TIMEOUT_MS = 90_000;

/** 事件：请求换背景。 */
export type SceneJobRequest = { type: "request"; jobId: string; at: number };
/** 事件：扩写完成（拿到 spec）。 */
export type SceneJobWritten = { type: "written"; jobId: string; label: string; at: number };
/** 事件：扩写拒绝。 */
export type SceneJobRejected = { type: "rejected"; jobId: string; note: string; at: number };
/** 事件：两张图都就绪。 */
export type SceneJobReady = { type: "ready"; jobId: string; urls: { desktop: string; mobile: string }; at: number };
/** 事件：失败（扩写非法 / 生图超时 / 只成一张 / 网络错误）。 */
export type SceneJobFailed = { type: "failed"; jobId: string; error: string; at: number };

export type SceneJobEvent = SceneJobRequest | SceneJobWritten | SceneJobRejected | SceneJobReady | SceneJobFailed;

/** 判定结果：是否允许发起，以及（不允许时）原因。 */
export type SceneJobAdmission = { ok: true } | { ok: false; reason: "cooldown" | "limit" | "busy" };

/**
 * 纯函数：判定当前是否允许发起新任务。
 * - 有进行中的任务（writing / generating）→ `busy`；
 * - 冷却 45 秒内 → `cooldown`；
 * - 已用次数 ≥ 5 → `limit`。
 */
export function admitSceneJob(state: SceneJobState, at: number): SceneJobAdmission {
  if (state.current !== null && (state.current.status === "writing" || state.current.status === "generating")) {
    return { ok: false, reason: "busy" };
  }
  if (state.lastFinishedAt !== null && at - state.lastFinishedAt < SCENE_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown" };
  }
  if (state.used >= SCENE_MAX_JOBS) {
    return { ok: false, reason: "limit" };
  }
  return { ok: true };
}

/**
 * 纯函数：状态转移。
 * 非法转移（如 ready 后再写）原样返回，不抛错。
 */
export function sceneJobReducer(state: SceneJobState, event: SceneJobEvent): SceneJobState {
  switch (event.type) {
    case "request": {
      // 同时只允许一个任务：已有进行中任务时不接受新请求。
      if (state.current !== null && (state.current.status === "writing" || state.current.status === "generating")) {
        return state;
      }
      return {
        ...state,
        current: { jobId: event.jobId, status: "writing", startedAt: event.at, updatedAt: event.at },
        used: state.used + 1,
      };
    }
    case "written": {
      if (state.current === null || state.current.jobId !== event.jobId || state.current.status !== "writing") return state;
      return {
        ...state,
        current: { ...state.current, status: "generating", label: event.label, updatedAt: event.at },
      };
    }
    case "rejected": {
      if (state.current === null || state.current.jobId !== event.jobId || state.current.status !== "writing") return state;
      return {
        ...state,
        current: null,
        lastFinishedAt: event.at,
      };
    }
    case "ready": {
      if (state.current === null || state.current.jobId !== event.jobId || state.current.status !== "generating") return state;
      return {
        ...state,
        current: { ...state.current, status: "ready", urls: event.urls, updatedAt: event.at },
        lastFinishedAt: event.at,
      };
    }
    case "failed": {
      if (state.current === null || state.current.jobId !== event.jobId) return state;
      // S6g-A §4.5：failed 只在 writing / generating 下生效——已 ready 的任务不能被迟到的超时改成 failed。
      if (state.current.status !== "writing" && state.current.status !== "generating") return state;
      return {
        ...state,
        current: { ...state.current, status: "failed", error: event.error, updatedAt: event.at },
        lastFinishedAt: event.at,
      };
    }
  }
}
