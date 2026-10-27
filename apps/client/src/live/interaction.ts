/**
 * S6l §5/§6：点击意图判定（纯函数）。
 *
 * - 忧奈说话时，点画面任何位置 = 打断（`interrupt`）；
 * - 忧奈没说话（idle / listening）时，点到忧奈本人 = 戳一下（`poke`）；
 * - 其他情况 = 无事发生（`none`）。
 *
 * 送礼物不走这里（输入栏旁的按钮，独立冷却）。
 */
import type { Phase } from "../state/types";

export type TapIntent = "interrupt" | "poke" | "none";

/**
 * S6l-fix2 §1：舞台点击的排除选择器。落在这些元素内的事件一律忽略（不算舞台点击）。
 * 引导弹幕、字幕区、顶栏、输入区容器等都带 `data-no-stage-tap`。
 */
export const STAGE_TAP_EXCLUDE_SELECTOR =
  "button, a, input, textarea, select, [role=button], [data-no-stage-tap]";

/**
 * S6l-fix2 §1：纯函数——事件目标是否落在交互元素内。
 *
 * 传入 `EventTarget | null`（只用到 `closest` 这一个 DOM 能力，便于轻量替身单测）。
 * 目标自身或任一祖先命中 {@link STAGE_TAP_EXCLUDE_SELECTOR} → true（应忽略这次短按）。
 * 非元素 / null / 无 `closest` → false。
 */
export function isStageTapTarget(target: unknown): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null | undefined;
  if (element === null || element === undefined || typeof element.closest !== "function") return false;
  return element.closest(STAGE_TAP_EXCLUDE_SELECTOR) !== null;
}

/**
 * S6l-fix2 §1：一次舞台短按的完整判定（纯函数，便于单测）：
 * 交互元素内 / 未命中角色 / 相位不允许 → 返回 `null`（不改动任何状态）；
 * 否则返回点击意图（`interrupt` / `poke`）。
 *
 * `hitCharacter`：坐标是否落在角色画布包围盒内（由调用方用 DOM 矩形算好）。
 */
export function resolveStageTap(
  phase: Phase["kind"],
  target: unknown,
  hitCharacter: boolean,
): Exclude<TapIntent, "none"> | null {
  if (isStageTapTarget(target)) return null;
  const intent = tapIntent(phase, hitCharacter);
  return intent === "none" ? null : intent;
}

/**
 * 纯函数：给定客户端相位与「是否命中角色」，返回点击意图。
 *
 * - `speaking`（含 thinking？按 §6 只对 speaking 打断；thinking 时点画面不算打断）→ interrupt。
 *   注：§6 明确「忧奈说话时」= speaking。thinking 时不打断，避免误触。
 * - idle / listening 且命中角色 → poke。
 * - 其他 → none。
 */
export function tapIntent(phase: Phase["kind"], hitCharacter: boolean): TapIntent {
  if (phase === "speaking") return "interrupt";
  if ((phase === "idle" || phase === "listening") && hitCharacter) return "poke";
  return "none";
}
