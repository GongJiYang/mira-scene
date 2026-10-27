import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  actionSchema,
  beatSchema,
  emotionSchema,
  llmBeatSchema,
  parseLlmBeatLenient,
  storyNodeSchema,
  type Action,
  type Beat,
  type Emotion,
  type NormalizedLlmBeat,
  type StoryNode,
} from "@mira/protocol";
import { direct, type DirectorContext } from "../src/director/director";
import { ACTION_HANDS, FISH_EMOTION_TAGS } from "../src/director/vocab";
import { createInitialScene as createServerScene } from "../src/story";

const RUNS = 500;

const NODE_RANK: Record<StoryNode, number> = { arrive: 0, probe: 1, reveal: 2, ending: 3 };

/** 随机 JSON 风格的输入：非对象、类型错误、超长字符串、坏枚举都覆盖。 */
const anyLlmInput = fc.oneof(
  fc.anything(),
  fc.constantFrom(null, undefined, "text", 42, true, [], {}),
  fc.record(
    {
      say: fc.oneof(
        fc.anything(),
        fc.string({ minLength: 0, maxLength: 5_000 }),
        fc.array(fc.constantFrom("\"", "\\", "{", "}", "[", "]", "：", "，", "😀"), { maxLength: 40 }).map((parts) => parts.join("")),
      ),
      emotion: fc.oneof(fc.anything(), fc.constantFrom("neutral", "sad", "angry", "", 42)),
      suggest: fc.oneof(fc.anything(), fc.constantFrom("drink", "show_item", "wave", null)),
      advance: fc.oneof(fc.anything(), fc.constantFrom("arrive", "reveal", "climax", null)),
    },
    { requiredKeys: [] },
  ),
);

const emotionArb = fc.constantFrom<Emotion>(...emotionSchema.options);
const actionArb = fc.constantFrom<Action>(...actionSchema.options);
const storyNodeArb = fc.constantFrom<StoryNode>(...storyNodeSchema.options);

const sayArb = fc.oneof(
  fc.string(),
  fc.array(fc.constantFrom("雨", "停", "了", "，", "。", "？", "！", "…", "a", "😀"), { maxLength: 60 }).map((chars) => chars.join("")),
  fc.array(fc.constantFrom("字", "，", "。"), { minLength: 21, maxLength: 40 }).map((chars) => chars.join("")),
);

const llmBeatArb: fc.Arbitrary<NormalizedLlmBeat> = fc.record({
  say: sayArb,
  emotion: emotionArb,
  suggest: fc.option(actionArb, { nil: null }),
  advance: fc.option(storyNodeArb, { nil: null }),
});

/** 50–200 个 beat，并按 1–4 个 beat 一组切成多轮。 */
const scriptArb: fc.Arbitrary<NormalizedLlmBeat[][]> = fc
  .array(llmBeatArb, { minLength: 50, maxLength: 200 })
  .chain((beats) =>
    fc
      .array(fc.integer({ min: 1, max: 4 }), { minLength: beats.length, maxLength: beats.length })
      .map((sizes) => {
        const turns: NormalizedLlmBeat[][] = [];
        let index = 0;
        for (const size of sizes) {
          if (index >= beats.length) break;
          turns.push(beats.slice(index, index + size));
          index += size;
        }
        return turns;
      }),
  );

describe("属性：parseLlmBeatLenient 是总函数", () => {
  it(`${RUNS} 次：任意输入不抛错，输出总能通过 LlmBeat schema`, () => {
    fc.assert(
      fc.property(anyLlmInput, (input) => {
        const result = parseLlmBeatLenient(input);
        expect(llmBeatSchema.safeParse(result.llmBeat).success).toBe(true);
        expect(typeof result.llmBeat.say).toBe("string");
        expect(result.llmBeat.suggest === null || actionSchema.safeParse(result.llmBeat.suggest).success).toBe(true);
        expect(result.llmBeat.advance === null || storyNodeSchema.safeParse(result.llmBeat.advance).success).toBe(true);
        expect(Array.isArray(result.warnings)).toBe(true);
      }),
      { numRuns: RUNS, verbose: true },
    );
  });
});

describe("属性：direct 的契约后置条件与不变量", () => {
  // 单独跑约 3.7–4.2s；全量并行时负载更高，经常超过 vitest 默认 5s 超时，故显式放宽到 20s（强度不变）。
  it(`${RUNS} 次 × 50–200 beat：不抛错且逐条满足 §2.2`, { timeout: 20_000 }, () => {
    fc.assert(
      fc.property(scriptArb, (turns) => {
        let ctx: DirectorContext = {
          scene: createServerScene(),
          recentActions: [],
          advancedThisTurn: false,
          beatsThisTurn: 0,
        };
        const emitted: Beat[] = [];
        let maxNodeRank = 0;

        for (const turn of turns) {
          ctx = { ...ctx, advancedThisTurn: false, beatsThisTurn: 0 };
          let advances = 0;

          for (const llmBeat of turn) {
            const beforeHands = ctx.scene.hands;
            const beatsThisTurnBefore = ctx.beatsThisTurn;
            const result = direct(llmBeat, ctx);
            ctx = result.ctx;

            expect(result.beats.length).toBeGreaterThanOrEqual(1);
            expect(result.beats.length).toBeLessThanOrEqual(2);
            expect(ctx.beatsThisTurn).toBe(beatsThisTurnBefore + result.beats.length);

            let expectedHands = beforeHands;
            const revealThisBeat = result.beats.some(({ beat }) => beat.story?.advance === "reveal");
            for (const { beat, ttsText } of result.beats) {
              expect(beat.seq).toBe(0);
              expect(beatSchema.safeParse(beat).success).toBe(true);

              // ttsText = Fish 标签 + 台词；空台词为空。
              if (beat.say === "") {
                expect(ttsText).toBe("");
              } else {
                const tag = FISH_EMOTION_TAGS[beat.emotion];
                expect(ttsText).toBe(tag === null ? beat.say : `${tag} ${beat.say}`);
              }

              // 冷却：除剧情强制的 show_item 外，同一 action 在任意连续 3 个 beat 内最多一次。
              if (beat.action !== null && beat.story?.advance !== "reveal") {
                expect(emitted.slice(-2).map((previous) => previous.action)).not.toContain(beat.action);
              }

              // camera / fx / media 只能来自剧情规则或会话第一个 beat。
              const isFirstSessionBeat = emitted.length === 0;
              if (beat.story === null) {
                expect(beat.camera).toBeNull();
                expect(beat.media).toBeNull();
                if (beat.fx !== null) {
                  expect(beat.fx).toBe("rain_heavy");
                  expect(isFirstSessionBeat).toBe(true);
                }
              }
              if (beat.fx === "rain_heavy") expect(isFirstSessionBeat).toBe(true);
              if (beat.fx === "rain_stop") expect(beat.story?.advance).toBe("reveal");
              // S5 §5：reveal 带照片、ending 带剧情视频；两者都只来自剧情推进（不变量的意图未变）。
              if (beat.media !== null) {
                if (beat.media.type === "video") {
                  expect(beat.media).toEqual({ type: "video", id: "clip_ending" });
                  expect(beat.story?.advance).toBe("ending");
                  expect(beat.camera).toBe("wide");
                  expect(beat.fx).toBe("warm_glow");
                } else {
                  expect(beat.media).toEqual({ type: "photo", id: "photo_letters" });
                  expect(beat.story?.advance).toBe("reveal");
                  expect(beat.camera).toBe("close_up");
                  expect(beat.fx).toBe("rain_stop");
                }
              }

              // emotion 透传；reveal 的 neutral → sad 是唯一例外。
              if (revealThisBeat) {
                expect(beat.emotion).toBe(llmBeat.emotion === "neutral" ? "sad" : llmBeat.emotion);
              } else {
                expect(beat.emotion).toBe(llmBeat.emotion);
              }
              if (beat.story?.advance === "reveal") {
                expect(beat.action).toBe("show_item");
                expect(beat.hands).toBe("polaroid");
                expectedHands = "polaroid";
              } else if (beat.action === null || beat.action === "glance") {
                expect(beat.hands).toBe(expectedHands);
              } else {
                expect(beat.hands).toBe(ACTION_HANDS[beat.action]);
                expectedHands = beat.hands;
              }

              if (beat.story !== null) {
                advances += 1;
                expect(ctx.scene.node).toBe(beat.story.advance);
              }

              emitted.push(beat);
            }

            // 不变量：trust 0–3；剧情节点只进不退；recentActions 与最近 3 个 beat 一致。
            expect(Number.isInteger(ctx.scene.trust)).toBe(true);
            expect(ctx.scene.trust).toBeGreaterThanOrEqual(0);
            expect(ctx.scene.trust).toBeLessThanOrEqual(3);
            expect(NODE_RANK[ctx.scene.node]).toBeGreaterThanOrEqual(maxNodeRank);
            maxNodeRank = NODE_RANK[ctx.scene.node];
            expect(ctx.recentActions).toEqual(emitted.slice(-3).map((beat) => beat.action));
          }

          // 每轮最多推进一步。
          expect(advances).toBeLessThanOrEqual(1);
          ctx = { ...ctx, scene: { ...ctx.scene, turnCount: ctx.scene.turnCount + 1 } };
        }
      }),
      { numRuns: RUNS, verbose: true },
    );
  });
});

describe("属性：parse 之后 direct 仍满足契约", () => {
  it(`${RUNS} 次：任意原始输出经 parseLlmBeatLenient → direct 不抛错`, () => {
    fc.assert(
      fc.property(anyLlmInput, (input) => {
        const { llmBeat } = parseLlmBeatLenient(input);
        const result = direct(llmBeat, {
          scene: createServerScene(),
          recentActions: [],
          advancedThisTurn: false,
          beatsThisTurn: 0,
        });
        expect(result.beats.length).toBeGreaterThanOrEqual(1);
        for (const { beat } of result.beats) expect(beatSchema.safeParse(beat).success).toBe(true);
      }),
      { numRuns: RUNS, verbose: true },
    );
  });
});
