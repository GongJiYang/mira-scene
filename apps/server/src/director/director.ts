import {
  type Accent,
  type Action,
  type Beat,
  type Camera,
  type Emotion,
  type Fx,
  type Hands,
  type Media,
  type NormalizedLlmBeat,
  type SceneState,
  type StoryNode,
} from "@mira/protocol";
import { advanceScene, applyBeatToScene, evaluateStoryAdvance } from "../story";
import type { NodeVisual } from "../characters/pack";
import { pickAccent } from "./accent";
import { ACTION_HANDS, buildTtsText } from "./vocab";

/** 采纳过的动作在最近 3 个 beat 内不再采纳（D29）。 */
const RECENT_ACTION_LIMIT = 3;
/** D47：accent 冷却需要「最近 10 个 beat」的窗口（飞头 / 飞宠）。 */
const RECENT_ACCENT_LIMIT = 10;
/** 本轮第一句的上限（D19 / D29）。 */
const FIRST_BEAT_MAX_CHARS = 20;
const SPLIT_PUNCTUATION = "，。？！…";

/**
 * 导演层上下文。
 * - `recentActions`：最近 3 个产出 beat 的 action（按时间顺序，含 null）。
 * - `recentAccents`：最近 10 个产出 beat 的 accent（按时间顺序，含 null），供 accent 冷却判定。
 * - `advancedThisTurn` / `beatsThisTurn`：每轮开始由会话层重置。
 * - `nodeVisuals`：S6g-A §2：角色包的剧情节点视觉表（镜头 / 特效 / 媒体 / 强制动作）。
 *   导演层只能从这里取 fx / media，保证「任意 LLM 输出都不会产生包里没有的 fx / media id」。
 */
export type DirectorContext = {
  scene: SceneState;
  recentActions: readonly (Action | null)[];
  recentAccents: readonly (Accent | null)[];
  advancedThisTurn: boolean;
  beatsThisTurn: number;
  nodeVisuals: Partial<Record<SceneState["node"], NodeVisual>>;
  /**
   * S6l §5：本轮输入类型（text / poke / gift）。poke / gift 时的 accent 规则与 gift 的 fx hearts。
   */
  inputKind?: "text" | "poke" | "gift";
  /** S6l §5：戳一下的序号（从 0 开始），用于 poke 的 shy / angry 轮流。 */
  pokeIndex?: number;
  /**
   * §1：导演层保底推进目标。LLM 本轮未提出 advance 时，若此项非空则在本 beat 上强制推进到它
   * （仍走 `story.ts` 校验、视觉照节点表）。由会话层只在「本轮第一个 beat」上注入。
   */
  forcedAdvanceTo?: StoryNode;
};

/** `seq` 由会话层统一分配；导演层只填 0。 */
export type DirectedBeat = {
  beat: Beat;
  ttsText: string;
};

export type DirectResult = {
  beats: DirectedBeat[];
  ctx: DirectorContext;
};

function splitFirstSentence(say: string, enabled: boolean): string[] {
  if (!enabled) return [say];

  const chars = [...say];
  if (chars.length <= FIRST_BEAT_MAX_CHARS) return [say];

  // 在 20 个字以内找离上限最近的标点，从后往前扫。
  for (let index = FIRST_BEAT_MAX_CHARS - 1; index >= 0; index -= 1) {
    const char = chars[index];
    if (char === undefined || !SPLIT_PUNCTUATION.includes(char)) continue;
    const head = chars.slice(0, index + 1).join("").trim();
    const tail = chars.slice(index + 1).join("").trim();
    if (head === "" || tail === "") return [say];
    return [head, tail];
  }
  return [say];
}

/**
 * 纯函数：LlmBeat → 一或两个 DirectedBeat。
 *
 * 后置条件（D29 §2.2）：
 * 1. emotion 透传（reveal 时 neutral → sad 是唯一例外）。
 * 2. 每个 beat 最多一个动作；suggest 不在最近 3 个 beat 内才采纳。
 * 3. camera / fx / media 只来自剧情推进或会话第一个 beat。
 * 4. 本轮第一句超过 20 字时按标点切分，视觉字段只放第一个 beat。
 */
export function direct(llmBeat: NormalizedLlmBeat, ctx: DirectorContext): DirectResult {
  const recentActions = ctx.recentActions.slice(-RECENT_ACTION_LIMIT);
  let scene = ctx.scene;
  let advancedThisTurn = ctx.advancedThisTurn;
  let advancedTo: StoryNode | null = null;

  // 规则 3：剧情推进先用 story.ts 校验，每轮最多一步。
  if (llmBeat.advance !== null && !advancedThisTurn) {
    const decision = evaluateStoryAdvance(scene, llmBeat.advance);
    if (decision.ok) {
      scene = advanceScene(scene, decision.node);
      advancedThisTurn = true;
      advancedTo = decision.node;
    }
  }

  // §1：导演层保底推进。LLM 本轮没推进，但会话层判定「已允许未推进」需强制时，
  // 在本 beat 上强制推进到 `forcedAdvanceTo`（仍走 story.ts 校验、视觉照节点表）。
  if (!advancedThisTurn && ctx.forcedAdvanceTo !== undefined) {
    const decision = evaluateStoryAdvance(scene, ctx.forcedAdvanceTo);
    if (decision.ok) {
      scene = advanceScene(scene, decision.node);
      advancedThisTurn = true;
      advancedTo = decision.node;
    }
  }

  // 规则 1：emotion 透传（reveal 的 neutral → sad 在后面处理）。
  let emotion: Emotion = llmBeat.emotion;

  // 规则 2：动作冷却按「最近 3 个 beat」；glance 保持手部状态。
  let action: Action | null = null;
  let hands: Hands = scene.hands;
  if (llmBeat.suggest !== null && !recentActions.includes(llmBeat.suggest)) {
    action = llmBeat.suggest;
    const mapped = ACTION_HANDS[action];
    if (mapped !== null) hands = mapped;
  }

  // 规则 3（S6g-A §1/§2）：camera / fx / media 只来自角色包的剧情节点表。
  // 会话第一个 beat 不再写死 rain_heavy（旧雨景随夏凛删除）。
  let camera: Camera | null = null;
  let fx: Fx | null = null;
  let media: Media | null = null;

  if (advancedTo !== null) {
    const visual: NodeVisual = ctx.nodeVisuals[advancedTo] ?? { camera: null, fx: null, media: null, action: null };
    camera = visual.camera;
    fx = visual.fx;
    media = visual.media;
    // 节点强制动作（如 reveal 的 show_item）：覆盖 suggest 的冷却判断。
    if (visual.action !== null) {
      action = visual.action;
      const mapped = ACTION_HANDS[visual.action];
      if (mapped !== null) hands = mapped;
    }
    if (advancedTo === "reveal") {
      // s3-fix §2：记录「进入 reveal 的轮次」，供 advanceRule 判定两轮后才允许 ending。
      scene = { ...scene, revealTurn: scene.turnCount };
      // reveal 时 neutral → sad 是唯一例外（原逻辑保留）。
      if (emotion === "neutral") emotion = "sad";
    }
  }

  // 规则 5：只切本轮第一句；切不动就保持原样。
  const parts = splitFirstSentence(llmBeat.say, ctx.beatsThisTurn === 0);
  const beats: DirectedBeat[] = [];

  // D47：accent 只放在切分后的第一个 beat（第二个 beat 为 null）。
  // S6l-fix2 §2：LLM 给的 accent 始终采纳（不再因同时给了 suggest 而丢弃）；
  // 规则触发（熬夜类 → dark）只在 LLM 没给 accent 时生效（由 pickAccent 内部判定）。
  const accent: Accent | null = pickAccent({
    suggested: llmBeat.accent,
    emotion,
    say: llmBeat.say,
    recentAccents: ctx.recentAccents,
    // S6l §5：poke / gift 的规则触发（gift → love，poke → 轮流 shy / angry）。
    kind: ctx.inputKind,
    pokeIndex: ctx.pokeIndex,
  });

  // S6l §5：送礼物 → fx hearts（只放在本轮第一个 beat，与剧情推进的视觉不冲突时）。
  if (ctx.inputKind === "gift" && ctx.beatsThisTurn === 0 && fx === null) {
    fx = "hearts";
  }

  for (const [index, part] of parts.entries()) {
    const isFirst = index === 0;
    const beat: Beat = {
      seq: 0,
      say: part,
      emotion,
      accent: isFirst ? accent : null,
      hands: isFirst ? hands : scene.hands,
      action: isFirst ? action : null,
      camera: isFirst ? camera : null,
      fx: isFirst ? fx : null,
      media: isFirst ? media : null,
      story: isFirst && advancedTo !== null ? { advance: advancedTo } : null,
    };

    // 视觉状态逐 beat 持久化：后续 beat 与下一轮都从这里继续。
    scene = applyBeatToScene(scene, beat);
    beats.push({ beat, ttsText: buildTtsText(beat.emotion, beat.say) });
  }

  const nextRecentActions = [...recentActions, ...beats.map(({ beat }) => beat.action)].slice(-RECENT_ACTION_LIMIT);
  const nextRecentAccents = [...ctx.recentAccents, ...beats.map(({ beat }) => beat.accent)].slice(-RECENT_ACCENT_LIMIT);

  return {
    beats,
    ctx: {
      scene,
      recentActions: nextRecentActions,
      recentAccents: nextRecentAccents,
      advancedThisTurn,
      beatsThisTurn: ctx.beatsThisTurn + beats.length,
      nodeVisuals: ctx.nodeVisuals,
      inputKind: ctx.inputKind,
      pokeIndex: ctx.pokeIndex,
    },
  };
}
