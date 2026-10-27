/**
 * 弹幕（S6b §4）：纯函数。
 *
 * 只显示「用户自己发的」和「语音转写的文字」——不做假观众弹幕（D40 YAGNI）。
 * 桌面右侧弹幕栏、手机左下浮层共用同一份数据。
 */

export type DanmakuKind = "user" | "transcript";

export type Danmaku = {
  /** 单调递增的本地 id（用于 React key 与淡出顺序）。 */
  id: number;
  kind: DanmakuKind;
  text: string;
};

export type DanmakuState = {
  items: readonly Danmaku[];
  /** 下一个 id。 */
  nextId: number;
};

/** 桌面弹幕栏保留的条数（手机浮层另有更小的上限，见 `MAX_MOBILE_DANMAKU`）。 */
export const MAX_DESKTOP_DANMAKU = 50;
/** 手机浮层最多 6 条（S6b §4）。 */
export const MAX_MOBILE_DANMAKU = 6;

export const initialDanmakuState: DanmakuState = { items: [], nextId: 1 };

export type DanmakuAction =
  | { type: "APPEND"; kind: DanmakuKind; text: string; max?: number }
  | { type: "CLEAR" };

/**
 * 追加一条弹幕；超过 `max` 时从**最旧**的一端丢弃（新的在下、旧的向上淡出）。
 * 空文本忽略（避免语音转写空串产生空气泡）。
 */
export function danmakuReducer(state: DanmakuState, action: DanmakuAction): DanmakuState {
  switch (action.type) {
    case "APPEND": {
      const text = action.text.trim();
      if (text === "") return state;
      const max = action.max ?? MAX_DESKTOP_DANMAKU;
      const item: Danmaku = { id: state.nextId, kind: action.kind, text };
      const items = [...state.items, item];
      return {
        items: items.length > max ? items.slice(items.length - max) : items,
        nextId: state.nextId + 1,
      };
    }
    case "CLEAR":
      return { items: [], nextId: state.nextId };
  }
}

/**
 * 手机浮层：取最近 `limit` 条，并按「新的在下」排列（数组末尾 = 最新）。
 * 返回的数组顺序即渲染顺序（从上到下）。
 */
export function visibleDanmaku(items: readonly Danmaku[], limit = MAX_MOBILE_DANMAKU): Danmaku[] {
  if (limit <= 0) return [];
  return items.slice(-limit);
}

/** 淡出顺序：越靠前（越旧）越先淡出。返回每条的不透明度（0–1）。 */
export function danmakuOpacity(index: number, total: number): number {
  if (total <= 0) return 0;
  // 最旧的一条最淡（0.35），最新的一条完全不透明。
  const oldest = 0.35;
  if (total === 1) return 1;
  return oldest + (1 - oldest) * (index / (total - 1));
}
