import type { LlmBeat, StoryNode } from "@mira/protocol";
import { sleep, throwIfAborted } from "../../abort";
import type { Pack } from "../../characters/pack";
import { classifyIntent, type Intent } from "../../intent";
import type { LLMContext, LLMPort } from "../../ports";

function countPriorUserTurns(history: LLMContext["history"]): number {
  return history.filter((entry) => entry.role === "user").length;
}

/**
 * 剧情提议规则（S6b §1）：arrive→probe→reveal→ending 逐级推进；
 * probe→reveal 用角色的 `revealIntents`（夏凛 / 忧奈都是 ask_core | comfort）。
 */
function proposeStory(pack: Pack, node: StoryNode, intent: Intent, priorUserTurns: number): StoryNode | null {
  switch (node) {
    case "arrive":
      return priorUserTurns >= 1 ? "probe" : null;
    case "probe":
      return pack.revealIntents.includes(intent) ? "reveal" : null;
    case "reveal":
      return "ending";
    case "ending":
      return null;
  }
}

/**
 * 契约 ①：只产出 LlmBeat（say / emotion / suggest / advance）。
 * 台词与无声动作全部来自角色包 content.json：按「剧情节点 + 关键词意图」产出
 * 两句台词 + 一个无声动作 beat（say 为空串），剧情提议挂在最后一个 beat 上。
 */
export function composeBeats(ctx: LLMContext, pack: Pack): LlmBeat[] {
  const intent = classifyIntent(ctx.userText, pack.intentPatterns);

  if (ctx.nudge) {
    // S6l §4：沉默时按阶段抛钩子——节点有 hook 就说 hook，否则回退到全局 nudge 台词。
    const hook = pack.nodes[ctx.scene.node].hook;
    if (hook !== "") {
      return [
        { say: "", emotion: pack.nodes[ctx.scene.node].look.emotion, suggest: pack.nodes[ctx.scene.node].look.silentAction, advance: null, accent: null },
        { say: hook, emotion: pack.nodes[ctx.scene.node].look.emotion, suggest: null, advance: null, accent: null },
      ];
    }
    return pack.nudge.map((beat) => ({
      say: beat.say,
      emotion: beat.emotion,
      suggest: beat.suggest ?? null,
      advance: null,
      accent: beat.accent ?? null,
    }));
  }

  // S6l §5：戳一下 / 送礼物 → 角色的情景回应（来自 content.json 的 events）。
  // accent 由服务端导演层规则决定（这里不给 suggest，规则触发才生效）。
  if (ctx.kind === "poke" || ctx.kind === "gift") {
    const lines = pack.events[ctx.kind];
    return lines.map((say) => ({ say, emotion: "surprised", suggest: null, advance: null, accent: null }));
  }

  const node = ctx.scene.node;
  const script = pack.nodes[node];
  const [first, second] = script.lines[intent];

  const beats: LlmBeat[] = [
    // D47：Mock 演示 —— 节点 look 的 accent 放在这一轮第一句上（不新写台词）。
    { say: first, emotion: script.look.emotion, suggest: null, advance: null, accent: script.look.accent },
    { say: second, emotion: script.look.emotion, suggest: null, advance: null, accent: null },
    { say: "", emotion: script.look.emotion, suggest: script.look.silentAction, advance: null, accent: null },
  ];

  const advance = proposeStory(pack, node, intent, countPriorUserTurns(ctx.history));
  const last = beats.at(-1);
  if (advance && last) {
    last.advance = advance;
    if (node === "probe" && advance === "reveal") {
      // 进入 reveal 的那一轮：用 suggest 表达「把东西给对方看」，媒体/镜头/雨停由导演层给。
      last.suggest = "show_item";
      last.emotion = "sad";
    }
  }

  return beats;
}

export type MockLlmOptions = {
  /** 每个 beat 之间的延迟，默认 300ms。 */
  beatDelayMs?: number;
  /** 指定输出（测试注入），返回原始对象数组。 */
  script?: (ctx: LLMContext) => readonly unknown[];
};

export function createMockLlm(options: MockLlmOptions = {}): LLMPort {
  const beatDelayMs = options.beatDelayMs ?? 300;
  // 剧本来自本轮 ctx.pack（S6b §1：同一 Mock 适配器实例可服务多个角色）。
  const script = options.script ?? ((ctx: LLMContext) => composeBeats(ctx, ctx.pack as Pack));

  return {
    async *streamBeats(ctx, signal) {
      throwIfAborted(signal);
      const raw = script(ctx);
      for (let index = 0; index < raw.length; index += 1) {
        if (index > 0) await sleep(beatDelayMs, signal);
        throwIfAborted(signal);
        yield raw[index];
      }
    },
  };
}
