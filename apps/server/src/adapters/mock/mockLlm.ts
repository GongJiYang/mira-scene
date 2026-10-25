import type { Action, Camera, Emotion, Fx, Pose, StoryNode } from "@mira/protocol";
import { sleep, throwIfAborted } from "../../abort";
import type { LLMContext, LLMPort } from "../../ports";

export type Intent = "ask_waiting" | "ask_photo" | "comfort" | "greeting" | "other";

const INTENT_PATTERNS: ReadonlyArray<readonly [Intent, RegExp]> = [
  ["ask_waiting", /等|谁|为什么/],
  ["ask_photo", /照片|摄影|相机/],
  ["comfort", /没事|陪|别担心/],
  ["greeting", /你好|嗨/],
];

export function classifyIntent(text: string): Intent {
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(text)) return intent;
  }
  return "other";
}

type NodeLook = {
  emotion: Emotion;
  pose: Pose;
  camera: Camera | null;
  fx: Fx | null;
  silentAction: Action;
};

type NodeScript = {
  look: NodeLook;
  lines: Record<Intent, readonly [string, string]>;
};

/** 每个节点 × 每种意图各一组台词；口吻克制，不直接说出在等谁。 */
const SCRIPTS: Record<StoryNode, NodeScript> = {
  arrive: {
    look: { emotion: "calm", pose: "hold_cup", camera: null, fx: "rain_heavy", silentAction: "sip_coffee" },
    lines: {
      greeting: ["你来了。", "外面雨很大吧，先坐一会儿。"],
      ask_waiting: ["……你是在问我吗？", "我在等人。等一个人。"],
      ask_photo: ["相机？我很少拍自己。", "倒是桌上那张照片，我一直没换。"],
      comfort: ["谢谢。我没事。", "只是这种天气，容易想起些旧事。"],
      other: ["嗯。", "坐吧，位置一直空着。"],
    },
  },
  probe: {
    look: { emotion: "guarded", pose: "sit", camera: null, fx: "rain_heavy", silentAction: "glance_door" },
    lines: {
      greeting: ["雨好像小一点了。", "你冷不冷？"],
      ask_waiting: ["等谁……说了你也不认识。", "他没说会来，也没说不来。"],
      ask_photo: ["照片是很多年前拍的。", "那时候我还不太会看镜头。"],
      comfort: ["你不用陪我。", "不过……有人在，好像确实不一样。"],
      other: ["嗯，我在听。", "今天店里没什么客人。"],
    },
  },
  reveal: {
    look: { emotion: "sad", pose: "look_down", camera: "close_up", fx: "rain_stop", silentAction: "check_phone" },
    lines: {
      greeting: ["你还在啊。", "雨停了。"],
      ask_waiting: ["他答应过，会写信来。", "信到了，人没来。"],
      ask_photo: ["照片后面写着一行字。", "「等雨停」。"],
      comfort: ["我没事，真的。", "哭一下就好了。"],
      other: ["让我缓一会儿。", "……抱歉，走神了。"],
    },
  },
  ending: {
    look: { emotion: "warm", pose: "lean_in", camera: "wide", fx: "warm_glow", silentAction: "smile_softly" },
    lines: {
      greeting: ["谢谢今天陪我。", "该打烊了。"],
      ask_waiting: ["我大概不会一直等下去了。", "但今天，我想再等等。"],
      ask_photo: ["照片我会收起来。", "不是丢掉。"],
      comfort: ["我知道。", "谢谢你没有劝我别等。"],
      other: ["嗯。", "灯我留着。"],
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

type RawBeat = {
  seq: number;
  say: string;
  emotion: Emotion;
  pose: Pose;
  action: Action | null;
  camera: Camera | null;
  fx: Fx | null;
  media: { type: "video"; id: string } | null;
  story: { advance: StoryNode } | null;
};

function baseBeat(seq: number, say: string, look: NodeLook, action: Action | null = null): RawBeat {
  return {
    seq,
    say,
    emotion: look.emotion,
    pose: look.pose,
    action,
    camera: look.camera,
    fx: look.fx,
    media: null,
    story: null,
  };
}

/**
 * 按「剧情节点 + 关键词意图」产出 2–3 个 beat：
 * 两句台词 + 一个无声动作 beat（say 为空串），剧情提议挂在最后一个 beat 上。
 */
export function composeBeats(ctx: LLMContext): RawBeat[] {
  const node = ctx.scene.node;
  const intent = classifyIntent(ctx.userText);
  const script = SCRIPTS[node];
  const [first, second] = script.lines[intent];

  const beats: RawBeat[] = [
    baseBeat(0, first, script.look),
    baseBeat(1, second, script.look),
    baseBeat(2, "", script.look, script.look.silentAction),
  ];

  const advance = proposeStory(node, intent, countPriorUserTurns(ctx.history));
  if (advance) {
    const last = beats[beats.length - 1];
    if (last) last.story = { advance };
    // 进入 reveal 的那一轮：第一个 beat 带上信件片段与镜头/环境
    if (node === "probe" && advance === "reveal") {
      const opening = beats[0];
      if (opening) {
        opening.media = { type: "video", id: "letter_reveal" };
        opening.camera = "close_up";
        opening.fx = "rain_stop";
        opening.emotion = "sad";
      }
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
