import {
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
import { ACTION_HANDS, buildTtsText } from "./vocab";

/** 采纳过的动作在最近 3 个 beat 内不再采纳（D29）。 */
const RECENT_ACTION_LIMIT = 3;
/** 本轮第一句的上限（D19 / D29）。 */
const FIRST_BEAT_MAX_CHARS = 20;
const SPLIT_PUNCTUATION = "，。？！…";

/**
 * 导演层上下文。
 * - `recentActions`：最近 3 个产出 beat 的 action（按时间顺序，含 null）。
 * - `advancedThisTurn` / `beatsThisTurn`：每轮开始由会话层重置。
 */
export type DirectorContext = {
  scene: SceneState;
  recentActions: readonly (Action | null)[];
  advancedThisTurn: boolean;
  beatsThisTurn: number;
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

  // 规则 1：emotion 透传（reveal 的 neutral → sad 在后面处理）。
  let emotion: Emotion = llmBeat.emotion;

  // 规则 2：动作冷却按「最近 3 个 beat」；glance_window 保持手部状态。
  let action: Action | null = null;
  let hands: Hands = scene.hands;
  if (llmBeat.suggest !== null && !recentActions.includes(llmBeat.suggest)) {
    action = llmBeat.suggest;
    const mapped = ACTION_HANDS[action];
    if (mapped !== null) hands = mapped;
  }

  // 规则 3/4：先取会话第一个 beat 的雨声，再让剧情节点覆盖。
  let camera: Camera | null = null;
  let fx: Fx | null = null;
  let media: Media | null = null;
  if (scene.turnCount === 0 && ctx.beatsThisTurn === 0) {
    fx = "rain_heavy";
  }

  if (advancedTo === "reveal") {
    camera = "close_up";
    fx = "rain_stop";
    media = { type: "photo", id: "photo_letters" };
    action = "show_polaroid";
    hands = "polaroid";
    if (emotion === "neutral") emotion = "sad";
  } else if (advancedTo === "ending") {
    camera = "wide";
    fx = "warm_glow";
  }

  // 规则 5：只切本轮第一句；切不动就保持原样。
  const parts = splitFirstSentence(llmBeat.say, ctx.beatsThisTurn === 0);
  const beats: DirectedBeat[] = [];

  for (const [index, part] of parts.entries()) {
    const isFirst = index === 0;
    const beat: Beat = {
      seq: 0,
      say: part,
      emotion,
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

  return {
    beats,
    ctx: {
      scene,
      recentActions: nextRecentActions,
      advancedThisTurn,
      beatsThisTurn: ctx.beatsThisTurn + beats.length,
    },
  };
}
