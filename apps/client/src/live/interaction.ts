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
