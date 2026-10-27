/**
 * D47 / S6k §2：语境表情 accent 的导演层纯函数。
 *
 * `pickAccent` 决定一句 beat 最终采用哪个 accent —— 词表内的值还要过冷却与冲突两道关，
 * 不通过就返回 null（这一句没有额外表情）。规则按顺序：
 *
 * 1. **规则触发**：`suggested` 为空且台词含「熬夜 / 没睡 / 通宵」任一 → 候选 `dark`。
 *    （「@送礼物 → love」挪到 S6i，本批不做。）
 * 2. **冲突不采纳**（返回 null）：sad 不配 love / heart / fly_head / fly_pet；
 *    warm 不配 angry / black / cry；guarded 不配 love / heart。
 * 3. **冷却**：`recentAccents` 是最近 beat 的 accent 序列（含 null）。fly_head / fly_pet
 *    在最近 10 个 beat 内出现过同名 → null；其余 accent 在最近 3 个 beat 内出现过同名 → null。
 *
 * 纯函数：不依赖时钟、不依赖随机数，同样输入必得同样输出。
 */
import type { Accent, Emotion } from "@mira/protocol";

/** 规则触发：台词命中这些词，且 LLM 没给 suggestion 时，用 `dark`（黑眼圈、困）。 */
export const DARK_TRIGGERS: readonly string[] = ["熬夜", "没睡", "通宵"];

/** 冷却窗口：特殊 accent（飞头 / 飞宠）更长（10），其余 3。 */
export const SPECIAL_ACCENT_COOLDOWN = 10;
export const DEFAULT_ACCENT_COOLDOWN = 3;
export const SPECIAL_ACCENTS: readonly Accent[] = ["fly_head", "fly_pet"];

/**
 * 冲突表：这些 (emotion, accent) 组合不采纳，返回 null。
 * 键为 emotion，值为该 emotion 下禁止的 accent 列表。
 */
export const ACCENT_CONFLICTS: Partial<Record<Emotion, readonly Accent[]>> = {
  sad: ["love", "heart", "fly_head", "fly_pet"],
  warm: ["angry", "black", "cry"],
  guarded: ["love", "heart"],
};

export type PickAccentInput = {
  /** LLM 给出的 accent（可为 null / undefined；词表外由协议层降级为 null）。 */
  suggested: Accent | null | undefined;
  emotion: Emotion;
  say: string;
  /** 最近 beat 的 accent 序列（含 null），按时间顺序。 */
  recentAccents: readonly (Accent | null)[];
  /**
   * S6l §5：本轮输入类型。`gift` → love；`poke` → 轮流 shy / angry。
   * 规则触发会覆盖 `suggested`，但仍受冲突表与冷却约束。
   */
  kind?: "text" | "poke" | "gift";
  /** S6l §5：戳一下的序号（从 0 开始），用于 poke 的 shy / angry 轮流。 */
  pokeIndex?: number;
};

/** gift / poke 的规则触发候选（覆盖 LLM 给的 accent）。 */
export function eventAccent(kind: "poke" | "gift", pokeIndex: number): Accent {
  if (kind === "gift") return "love";
  return pokeIndex % 2 === 0 ? "shy" : "angry";
}

/** 冷却判定：该 accent 是否在最近窗口内出现过同名。 */
function onCooldown(accent: Accent, recentAccents: readonly (Accent | null)[]): boolean {
  const window = SPECIAL_ACCENTS.includes(accent) ? SPECIAL_ACCENT_COOLDOWN : DEFAULT_ACCENT_COOLDOWN;
  const recent = recentAccents.slice(-window);
  return recent.includes(accent);
}

/** 冲突判定：该 emotion 下是否禁止这个 accent。 */
function conflictsWith(emotion: Emotion, accent: Accent): boolean {
  return ACCENT_CONFLICTS[emotion]?.includes(accent) ?? false;
}

export function pickAccent(input: PickAccentInput): Accent | null {
  // S6l §5：poke / gift 的规则触发覆盖 LLM 给的 accent。
  // gift 冲突（如 sad 不配 love）时改用 heart（同样受冲突表约束）。
  if (input.kind === "poke" || input.kind === "gift") {
    let candidate = eventAccent(input.kind, input.pokeIndex ?? 0);
    if (conflictsWith(input.emotion, candidate)) {
      candidate = input.kind === "gift" ? "heart" : candidate;
    }
    if (conflictsWith(input.emotion, candidate)) return null;
    if (onCooldown(candidate, input.recentAccents)) return null;
    return candidate;
  }

  // 规则触发：LLM 没给 suggestion（这里由调用方保证 suggested 为空），台词命中熬夜类词 → dark。
  let candidate: Accent | null = input.suggested ?? null;
  if (candidate === null) {
    if (DARK_TRIGGERS.some((word) => input.say.includes(word))) candidate = "dark";
  }
  if (candidate === null) return null;

  // 冲突不采纳。
  if (conflictsWith(input.emotion, candidate)) return null;

  // 冷却不采纳。
  if (onCooldown(candidate, input.recentAccents)) return null;

  return candidate;
}
