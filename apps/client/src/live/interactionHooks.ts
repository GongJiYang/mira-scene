/**
 * S6l §3/§5/§6：直播间轻互动的客户端逻辑（React 外壳）。
 *
 * - §3 观众引导弹幕：用户和角色都安静（idle）约 8 秒刷 1 条；同时最多 3 条；点过不再出现；切节点失效。
 * - §5 戳一下 / 送礼物：冷却 3s / 10s。
 * - §6 点击打断：由 `tapIntent` 判定，speaking 时点画面 → 打断。
 *
 * 纯决策在 `guides.ts` / `interaction.ts`；这里只做计时、React 状态与调用意图。
 */
import { useCallback, useEffect, useRef } from "react";
import type { DanmakuAction } from "./danmaku";
import { MAX_VISIBLE_GUIDES, nextGuide } from "./guides";
import { tapIntent } from "./interaction";
import { characterOrDefault } from "./characters";

/** 刷引导弹幕的间隔（用户和角色都安静约 8 秒）。 */
export const GUIDE_INTERVAL_MS = 8_000;
/** 戳一下的冷却（§5）。 */
export const POKE_COOLDOWN_MS = 3_000;
/** 送礼物的冷却（§5）。 */
export const GIFT_COOLDOWN_MS = 10_000;

/** 观众昵称词库（沿用现有随机昵称机制；这里是唯一列表）。 */
export const VIEWER_NICKNAMES: readonly string[] = [
  "路过的猫",
  "深夜不睡",
  "蓝色的风",
  "第三个观众",
  "半罐能量饮料",
  "老粉在此",
  "悄悄看",
  "弹幕机",
];

/** 随机昵称（注入 rng 便于单测）。 */
export function randomNickname(rng: () => number): string {
  const index = Math.floor(rng() * VIEWER_NICKNAMES.length);
  return VIEWER_NICKNAMES[index] ?? VIEWER_NICKNAMES[0] ?? "观众";
}

export type LiveInteractionDeps = {
  /** 当前剧情节点（服务端下发）。 */
  node: string;
  /** 当前相位（idle / listening / thinking / speaking / error）。 */
  phase: string;
  /** 弹幕 dispatch（追加引导 / 用户弹幕）。 */
  dispatchDanmaku: (action: DanmakuAction) => void;
  /** 当前显示在弹幕区的引导文字（用于去重与进度点）。 */
  visibleGuides: readonly string[];
  /** 本节点已用过的引导。 */
  usedGuides: () => readonly string[];
  /** 标记引导已用（点过）。 */
  markUsed: (guide: string) => void;
  /** 点击引导 / 发送用户文字。 */
  submitText: (text: string) => void;
  /** 戳一下。 */
  poke: () => void;
  /** 送礼物。 */
  gift: () => void;
  /** 点击打断。 */
  tapInterrupt: () => void;
  /** 当前角色 id（取 guides 表）。 */
  characterId: string;
  /** 注入时钟 / 随机数（测试）。 */
  now?: () => number;
  rng?: () => number;
};

/**
 * 引导弹幕调度（§3）：
 * - 只在「用户和角色都安静」时刷（phase 为 idle；thinking / speaking / listening 都不刷），
 *   初始 8 秒计时从进入 idle 开始。
 * - 每 8 秒选一条未用、未显示的引导；同时最多 3 条。
 * - 切节点后旧引导失效（由外层清空 visible/used，调度只看当前节点）。
 */
export function useGuideScheduler(deps: LiveInteractionDeps): void {
  const { node, phase, characterId, dispatchDanmaku, visibleGuides } = deps;
  const rng = deps.rng ?? Math.random;
  const usedRef = useRef(deps.usedGuides);
  usedRef.current = deps.usedGuides;
  const visibleRef = useRef(visibleGuides);
  visibleRef.current = visibleGuides;
  const markRef = useRef(deps.markUsed);
  markRef.current = deps.markUsed;

  useEffect(() => {
    // thinking / speaking / listening 时不刷（用户或角色不安静）。
    if (phase !== "idle") return;
    const character = characterOrDefault(characterId);
    const guides = character.guides[node as keyof typeof character.guides] ?? [];
    if (guides.length === 0) return;

    const timer = window.setInterval(() => {
      if (visibleRef.current.length >= MAX_VISIBLE_GUIDES) return;
      const guide = nextGuide({ guides, usedGuides: usedRef.current(), visibleGuides: visibleRef.current });
      if (guide === null) return;
      // 出现即算「已用」（点过的不再出现；不点的也不再重复刷同一条）。
      markRef.current(guide);
      dispatchDanmaku({ type: "APPEND", kind: "guide", text: guide, nickname: randomNickname(rng), max: 50 });
    }, GUIDE_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [node, phase, characterId, dispatchDanmaku, rng]);
}

/**
 * 点击画面（§5/§6）：用 `tapIntent` 判定 → 打断 / 戳一下 / 无事。
 * `hitCharacter` 由调用方（舞台）给出。
 */
export function resolveTap(phase: string, hitCharacter: boolean): "interrupt" | "poke" | "none" {
  return tapIntent(phase as never, hitCharacter);
}

/**
 * 冷却门（§5）：返回一个 `tryUse()`，首次即可用；冷却内返回 false。
 * 时钟注入，便于单测。
 */
export function createCooldown(ms: number, now: () => number = Date.now): () => boolean {
  let last = -Infinity;
  return () => {
    const at = now();
    if (at - last < ms) return false;
    last = at;
    return true;
  };
}

/** React 版：戳一下 / 送礼物的冷却门。 */
export function useInteractionCooldowns(deps: Pick<LiveInteractionDeps, "poke" | "gift" | "now">): {
  poke: () => void;
  gift: () => void;
} {
  const now = deps.now ?? Date.now;
  const pokeGate = useRef<() => boolean>(createCooldown(POKE_COOLDOWN_MS, now));
  const giftGate = useRef<() => boolean>(createCooldown(GIFT_COOLDOWN_MS, now));

  const poke = useCallback(() => {
    if (pokeGate.current()) deps.poke();
  }, [deps]);
  const gift = useCallback(() => {
    if (giftGate.current()) deps.gift();
  }, [deps]);

  return { poke, gift };
}
