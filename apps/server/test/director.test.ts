import { describe, expect, it } from "vitest";
import {
  beatSchema,
  type Emotion,
  type NormalizedLlmBeat,
  type SceneState,
} from "@mira/protocol";
import { direct, type DirectorContext } from "../src/director/director";
import { composeBeats } from "../src/adapters/mock/mockLlm";
import { createInitialScene } from "../src/story";

function llmBeat(overrides: Partial<NormalizedLlmBeat> = {}): NormalizedLlmBeat {
  return { say: "雨还在下。", emotion: "calm", suggest: null, advance: null, ...overrides };
}

function context(overrides: Partial<DirectorContext> = {}): DirectorContext {
  return {
    scene: createInitialScene(),
    recentActions: [],
    advancedThisTurn: false,
    beatsThisTurn: 0,
    ...overrides,
  };
}

function sceneAt(node: SceneState["node"], overrides: Partial<SceneState> = {}): SceneState {
  return { ...createInitialScene(), node, ...overrides };
}

const TTS_EXPECTATIONS: Record<Emotion, (say: string) => string> = {
  neutral: (say) => say,
  calm: (say) => `[calm] ${say}`,
  guarded: (say) => `[soft tone] ${say}`,
  sad: (say) => `[sad] ${say}`,
  warm: (say) => `[gentle] ${say}`,
  surprised: (say) => `[surprised] ${say}`,
};

describe("导演层：情绪与 TTS 文本", () => {
  it("emotion 直接透传，TTS 文本按 §2.1 加标签", () => {
    for (const [emotion, expected] of Object.entries(TTS_EXPECTATIONS) as Array<[Emotion, (say: string) => string]>) {
      const result = direct(llmBeat({ emotion, say: "嗯。" }), context());
      const directed = result.beats[0];
      expect(directed).toBeDefined();
      expect(directed?.beat.emotion).toBe(emotion);
      expect(directed?.ttsText).toBe(expected("嗯。"));
    }
  });

  it("台词为空时 ttsText 也为空（不加标签）", () => {
    const result = direct(llmBeat({ emotion: "surprised", say: "" }), context());
    expect(result.beats[0]?.ttsText).toBe("");
    expect(result.beats[0]?.beat.say).toBe("");
  });
});

describe("导演层：动作与冷却", () => {
  it("采纳 suggest 并按 §2.1 设置手部；glance_window 保持当前手部", () => {
    const cases = [
      { suggest: "sip_coffee", hands: "phone", expectedHands: "cup" },
      { suggest: "show_polaroid", hands: "cup", expectedHands: "polaroid" },
      { suggest: "check_phone", hands: "cup", expectedHands: "phone" },
      { suggest: "glance_window", hands: "camera", expectedHands: "camera" },
    ] as const;

    for (const { suggest, hands, expectedHands } of cases) {
      const result = direct(llmBeat({ suggest }), context({ scene: sceneAt("arrive", { hands }) }));
      expect(result.beats[0]?.beat.action).toBe(suggest);
      expect(result.beats[0]?.beat.hands).toBe(expectedHands);
    }
  });

  it("每个 beat 最多一个动作：没有 suggest 时 action 为 null", () => {
    const result = direct(llmBeat({ suggest: null }), context());
    expect(result.beats[0]?.beat.action).toBeNull();
  });

  it("最近 3 个 beat 内出现过的动作不再采纳，间隔 4 个 beat 后可再次采纳", () => {
    let ctx = context();
    const actions: Array<string | null> = [];
    for (let index = 0; index < 5; index += 1) {
      const result = direct(llmBeat({ suggest: "sip_coffee" }), ctx);
      ctx = result.ctx;
      actions.push(result.beats[0]?.beat.action ?? null);
    }
    expect(actions).toEqual(["sip_coffee", null, null, null, "sip_coffee"]);
  });

  it("拒绝 suggest 时 action=null 且 hands 保持", () => {
    const result = direct(
      llmBeat({ suggest: "check_phone" }),
      context({ scene: sceneAt("arrive", { hands: "polaroid" }), recentActions: [null, "check_phone", null] }),
    );
    expect(result.beats[0]?.beat.action).toBeNull();
    expect(result.beats[0]?.beat.hands).toBe("polaroid");
  });
});

describe("导演层：剧情与视觉", () => {
  it("进入 reveal：photo_letters / close_up / rain_stop / show_polaroid / polaroid，neutral 改 sad", () => {
    const result = direct(
      llmBeat({ emotion: "neutral", advance: "reveal", say: "他第一封信里说，不敢打电话。" }),
      context({ scene: sceneAt("probe") }),
    );
    const beat = result.beats[0]?.beat;
    expect(beat).toMatchObject({
      camera: "close_up",
      fx: "rain_stop",
      media: { type: "photo", id: "photo_letters" },
      action: "show_polaroid",
      hands: "polaroid",
      emotion: "sad",
      story: { advance: "reveal" },
    });
    expect(result.ctx.scene.node).toBe("reveal");
    expect(result.ctx.scene.trust).toBe(1);
  });

  it("进入 reveal 时 emotion 非 neutral 则保持", () => {
    const result = direct(
      llmBeat({ emotion: "guarded", advance: "reveal" }),
      context({ scene: sceneAt("probe") }),
    );
    expect(result.beats[0]?.beat.emotion).toBe("guarded");
  });

  // S5 §5：`media` 由 `null` 改为剧情视频（唯一改动是这一行的字面值，逻辑断言不变）。
  it("进入 ending：camera=wide、fx=warm_glow、media=剧情视频 clip_ending", () => {
    const result = direct(llmBeat({ emotion: "warm", advance: "ending" }), context({ scene: sceneAt("reveal") }));
    expect(result.beats[0]?.beat).toMatchObject({
      camera: "wide",
      fx: "warm_glow",
      media: { type: "video", id: "clip_ending" },
      story: { advance: "ending" },
    });
  });

  it("会话第一个 beat 带 rain_heavy，之后不再重复", () => {
    const first = direct(llmBeat(), context());
    expect(first.beats[0]?.beat.fx).toBe("rain_heavy");

    const second = direct(llmBeat(), first.ctx);
    expect(second.beats[0]?.beat.fx).toBeNull();
  });

  it("没有通过校验的推进不产生视觉覆盖", () => {
    const result = direct(llmBeat({ advance: "reveal" }), context({ scene: sceneAt("arrive"), beatsThisTurn: 1 }));
    expect(result.beats[0]?.beat).toMatchObject({
      story: null,
      camera: null,
      fx: null,
      media: null,
    });
    expect(result.ctx.scene.node).toBe("arrive");
    expect(result.ctx.scene.trust).toBe(0);
  });

  it("每轮最多推进一步", () => {
    const result = direct(
      llmBeat({ advance: "reveal" }),
      context({ scene: sceneAt("probe"), advancedThisTurn: true }),
    );
    expect(result.beats[0]?.beat.story).toBeNull();
    expect(result.beats[0]?.beat.camera).toBeNull();
    expect(result.ctx.scene.node).toBe("probe");
  });

  it("trust 不会超过 3", () => {
    const result = direct(llmBeat({ advance: "ending" }), context({ scene: sceneAt("reveal", { trust: 3 }) }));
    expect(result.ctx.scene.trust).toBe(3);
  });

  it("camera / fx / media 在其余情况一律为 null", () => {
    const result = direct(
      llmBeat({ advance: null }),
      context({ scene: sceneAt("probe"), beatsThisTurn: 1 }),
    );
    expect(result.beats[0]?.beat.camera).toBeNull();
    expect(result.beats[0]?.beat.fx).toBeNull();
    expect(result.beats[0]?.beat.media).toBeNull();
  });
});

describe("导演层：第一句限长", () => {
  it("超过 20 字按最近标点切成两个 beat，视觉字段只在第一个", () => {
    const result = direct(
      llmBeat({ emotion: "neutral", advance: "reveal", say: "第一句很短，第二句稍微长一点点也没有关系。" }),
      context({ scene: sceneAt("probe") }),
    );
    expect(result.beats).toHaveLength(2);
    expect(result.beats[0]?.beat.say).toBe("第一句很短，");
    expect(result.beats[1]?.beat.say).toBe("第二句稍微长一点点也没有关系。");
    expect(result.beats[0]?.beat).toMatchObject({
      emotion: "sad",
      camera: "close_up",
      fx: "rain_stop",
      media: { type: "photo", id: "photo_letters" },
      action: "show_polaroid",
      hands: "polaroid",
      story: { advance: "reveal" },
    });
    expect(result.beats[1]?.beat).toMatchObject({
      camera: null,
      fx: null,
      media: null,
      action: null,
      story: null,
      hands: "polaroid",
    });
    expect(result.beats[1]?.ttsText).toBe("[sad] 第二句稍微长一点点也没有关系。");
    expect(result.ctx.beatsThisTurn).toBe(2);
  });

  it("不超过 20 字不切", () => {
    const say = "一二三四五六七八九十一二三四五六七八九十";
    const result = direct(llmBeat({ say }), context());
    expect(result.beats).toHaveLength(1);
  });

  it("20 字以内找不到标点时不切", () => {
    const say = "一二三四五六七八九十一二三四五六七八九十后面还有很长的内容";
    const result = direct(llmBeat({ say }), context());
    expect(result.beats).toHaveLength(1);
    expect(result.beats[0]?.beat.say).toBe(say);
  });

  it("只有本轮第一个 beat 受长度限制", () => {
    const say = "第一句很短，第二句稍微长一点点也没有关系。";
    const result = direct(llmBeat({ say }), context({ beatsThisTurn: 1 }));
    expect(result.beats).toHaveLength(1);
    expect(result.beats[0]?.beat.say).toBe(say);
  });
});

describe("导演层：迁移自 mockLlm 的 reveal 验收", () => {
  it("进入 reveal 的那一轮出现 photo_letters / close_up / rain_stop / show_polaroid / polaroid", () => {
    let ctx = context({ scene: sceneAt("probe") });
    const directed = composeBeats({ history: [], scene: ctx.scene, userText: "你在等谁？" }).flatMap((beat) => {
      const result = direct({ ...beat, suggest: beat.suggest ?? null, advance: beat.advance ?? null }, ctx);
      ctx = result.ctx;
      return result.beats.map(({ beat: directedBeat }) => directedBeat);
    });

    const mediaBeat = directed.find((beat) => beat.media !== null);
    expect(mediaBeat).toMatchObject({
      media: { type: "photo", id: "photo_letters" },
      camera: "close_up",
      fx: "rain_stop",
      action: "show_polaroid",
      hands: "polaroid",
    });
    expect(directed.some((beat) => beat.story?.advance === "reveal")).toBe(true);
    expect(ctx.scene.node).toBe("reveal");
  });
});

describe("导演层：契约后置条件", () => {
  it("产出的 beat 总是合法的，seq 由会话层随后分配（这里为 0）", () => {
    const result = direct(llmBeat(), context());
    for (const { beat } of result.beats) {
      expect(beat.seq).toBe(0);
      expect(beatSchema.safeParse(beat).success).toBe(true);
    }
  });

  it("ctx 累计本轮 beat 数与会话可用状态", () => {
    const first = direct(llmBeat(), context());
    const second = direct(llmBeat(), first.ctx);
    expect(first.ctx.beatsThisTurn).toBe(1);
    expect(second.ctx.beatsThisTurn).toBe(2);
    expect(first.ctx.scene).toMatchObject({ node: "arrive", trust: 0 });
  });
});
