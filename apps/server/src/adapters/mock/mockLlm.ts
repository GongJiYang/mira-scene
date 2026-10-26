import type { Action, Emotion, LlmBeat, StoryNode } from "@mira/protocol";
import { sleep, throwIfAborted } from "../../abort";
import { classifyIntent, type Intent } from "../../intent";
import type { LLMContext, LLMPort } from "../../ports";

type NodeLook = {
  emotion: Emotion;
  /** 该节点的无声 beat 提议的动作；视觉结果由导演层决定。 */
  silentAction: Action;
};

type NodeScript = {
  look: NodeLook;
  lines: Record<Intent, readonly [string, string]>;
};

/**
 * 夏凛，27 岁，深夜电台《雨声信箱》主持人。
 * 雨夜快打烊的咖啡馆，她在等一位写了三年信、从没露面的听众。
 * 每个节点 × 每种意图各一组台词；不直接说出在等谁，靠凉掉的咖啡、信、雨声暗示。
 */
const SCRIPTS: Record<StoryNode, NodeScript> = {
  arrive: {
    look: { emotion: "calm", silentAction: "sip_coffee" },
    lines: {
      greeting: ["雨还在下。", "先坐吧，靠窗那桌干净。"],
      ask_waiting: ["……你是在问我吗？", "算是吧。有人说过今晚会来。"],
      ask_photo: ["拍立得？我带了很多年。", "相纸不多了，所以只拍要紧的。"],
      ask_radio: ["这么晚还在听电台？", "《雨声信箱》，我今晚刚下播。"],
      comfort: ["谢谢。", "我没事，就是坐一会儿。"],
      other: ["嗯。", "桌上那杯咖啡，一直没人动过。"],
    },
  },
  probe: {
    look: { emotion: "guarded", silentAction: "glance_window" },
    lines: {
      greeting: ["外面雨小一点了。", "你衣服湿了吗？"],
      ask_waiting: ["他没说几点到。", "我也没问。问了，好像就变成催了。"],
      ask_photo: ["这张是台里楼下的雨。", "拍的时候手抖了，反而像真的。"],
      ask_radio: ["写信的人，比打电话的多。", "有个人的字，我认得出来。"],
      comfort: ["你不用陪我坐这么久。", "不过……有人在，确实好一点。"],
      other: ["我在听。", "快打烊了，不着急。"],
    },
  },
  reveal: {
    look: { emotion: "sad", silentAction: "show_polaroid" },
    lines: {
      greeting: ["你还在。", "雨停了，玻璃上只剩水痕。"],
      ask_waiting: ["他第一封信里说，不敢打电话。", "我就把节目时段往后挪了半小时。"],
      ask_photo: ["这张背面有一行字。", "「等雨停」。是他写的。"],
      ask_radio: ["今晚的节目，我念了他的信。", "没念名字。他知道是他就行。"],
      comfort: ["我没事，真的。", "就是有点，说不上来。"],
      other: ["让我坐一会儿。", "……抱歉，刚才走神了。"],
    },
  },
  ending: {
    look: { emotion: "warm", silentAction: "check_phone" },
    lines: {
      greeting: ["谢谢你还在这儿。", "要打烊了。"],
      ask_waiting: ["我大概不会每天都等了。", "但今晚，想再等十分钟。"],
      ask_photo: ["照片我收起来了。", "不是丢掉。"],
      ask_radio: ["明天的节目照常。", "信箱还会开着。"],
      comfort: ["我知道。", "谢谢你没劝我别等。"],
      other: ["灯我留着。", "路上小心。"],
    },
  },
};

function countPriorUserTurns(history: LLMContext["history"]): number {
  return history.filter((entry) => entry.role === "user").length;
}

function proposeStory(node: StoryNode, intent: Intent, priorUserTurns: number): StoryNode | null {
  switch (node) {
    case "arrive":
      return priorUserTurns >= 1 ? "probe" : null;
    case "probe":
      return intent === "ask_waiting" || intent === "comfort" ? "reveal" : null;
    case "reveal":
      return "ending";
    case "ending":
      return null;
  }
}

/**
 * 契约 ①：只产出 LlmBeat（say / emotion / suggest / advance）。
 * 按「剧情节点 + 关键词意图」产出 2–3 个 beat：
 * 两句台词 + 一个无声动作 beat（say 为空串），剧情提议挂在最后一个 beat 上。
 */
export function composeBeats(ctx: LLMContext): LlmBeat[] {
  const node = ctx.scene.node;
  const intent = classifyIntent(ctx.userText);
  const script = SCRIPTS[node];
  const [first, second] = script.lines[intent];

  const beats: LlmBeat[] = [
    { say: first, emotion: script.look.emotion, suggest: null, advance: null },
    { say: second, emotion: script.look.emotion, suggest: null, advance: null },
    { say: "", emotion: script.look.emotion, suggest: script.look.silentAction, advance: null },
  ];

  const advance = proposeStory(node, intent, countPriorUserTurns(ctx.history));
  const last = beats.at(-1);
  if (advance && last) {
    last.advance = advance;
    if (node === "probe" && advance === "reveal") {
      // 进入 reveal 的那一轮：用 suggest 表达「翻拍立得」，媒体/镜头/雨停由导演层给。
      last.suggest = "show_polaroid";
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
  const script = options.script ?? composeBeats;

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
