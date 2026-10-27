import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  approach,
  approachParams,
  applyEyeOpen,
  ACCENT_KEYS,
  BREATH_BODY_AMPLITUDE,
  BREATH_HEAD_AMPLITUDE,
  BREATH_PERIOD_SEC,
  breathOffsets,
  clampParam,
  combineBlink,
  COMFORT_RANGES,
  DEFAULT_RANGE,
  EMOTION_EYE_MAX,
  EMOTION_KEYS,
  EMOTION_PARAMS,
  EYE_OPEN_MAX,
  FORBIDDEN_KEYS,
  GUARDED_EYE_MAX,
  HEART_FADE_SEC,
  idleActionParams,
  LISTEN_BODY_FORWARD,
  LISTEN_HEAD_TILT_Z,
  LISTEN_NOD_AMPLITUDE,
  LISTEN_NOD_PERIOD_SEC,
  LISTEN_TRANSITION_SEC,
  listenNodOffset,
  PET_FADE_SEC,
  petGradient,
  SILENT_ACTION_TABLE,
  SPEAK_AMAZED_SEC,
  speakAmazed,
  tearParams,
  THINK_EYE_MAX,
  THINK_HEAD_TILT_Z,
  yunaParams,
  type SilentAction,
  type YunaEmotion,
  type YunaParamInput,
} from "../src/render/live2d/yunaParams";
import { VIEW_LIMITS } from "../src/render/live2d/params";
import type { MouthShape, StagePhaseKind } from "../src/state/performance";
import type { Accent } from "@mira/protocol";

const PHASES: StagePhaseKind[] = ["idle", "listening", "thinking", "speaking", "error"];
const EMOTIONS: YunaEmotion[] = ["calm", "guarded", "sad", "warm", "neutral"];
const MOUTHS: MouthShape[] = ["closed", "small", "open"];
const SILENT_ACTIONS: SilentAction[] = ["drink", "glance", "phone", "show_item"];
const ACCENTS: Accent[] = ["love", "heart", "shy", "amazed", "cry", "angry", "black", "dark", "fly_head", "fly_pet"];

const base: YunaParamInput = { phase: "idle", emotion: "calm", mouth: "closed", blinkOpen: 1, tSec: 0 };

describe("clampParam：舒适区间是唯一出处", () => {
  it("已知参数用 COMFORT_RANGES，未知参数用 DEFAULT_RANGE", () => {
    expect(clampParam("ParamAngleX", 100)).toBe(30);
    expect(clampParam("ParamAngleX", -100)).toBe(-30);
    expect(clampParam("ParamMouthOpenY", 5)).toBe(2.1);
    expect(clampParam("ParamBrowL", 5)).toBe(1);
    expect(clampParam("ParamShy", -3)).toBe(-1);
  });

  it("NaN 归零", () => {
    expect(clampParam("ParamAngleX", Number.NaN)).toBe(0);
  });
});

describe("approach：逐帧插值", () => {
  it("dt=0 保持、dt=1 直达、中间线性", () => {
    expect(approach(0, 10, 0)).toBe(0);
    expect(approach(0, 10, 1)).toBe(10);
    expect(approach(0, 10, 0.5)).toBe(5);
  });

  it("非法 dt 视为 0", () => {
    expect(approach(3, 9, Number.NaN)).toBe(3);
    expect(approach(3, 9, -1)).toBe(3);
  });
});

describe("approachParams：逐键插值（S6a-fix1 §3）", () => {
  it("dt=0 不变、dt=1 直达、键集合等于 target", () => {
    const current = { A: 0, B: 10, C: 5 };
    const target = { A: 4, B: 0, D: 8 };
    // dt=0：保持 current 的对应值（target 中没有的键视同已在 target）。
    expect(approachParams(current, target, 0)).toEqual({ A: 0, B: 10, D: 8 });
    expect(approachParams(current, target, 1)).toEqual(target);
    expect(Object.keys(approachParams(current, target, 0.5)).sort()).toEqual(["A", "B", "D"]);
    expect(approachParams(current, target, 0.5).A).toBeCloseTo(2);
  });

  it("current 缺少的键视同已在 target（不跳变）", () => {
    expect(approachParams({}, { X: 7 }, 0.5)).toEqual({ X: 7 });
  });
});

describe("combineBlink：自动眨眼与手动眨眼相乘（S6a-fix1 §2）", () => {
  it("两者都为 1 时为 1（睁眼）", () => {
    expect(combineBlink(1, 1)).toBe(1);
  });

  it("自动眨眼到 0 时结果为 0（自动眨眼不被常量 1 覆盖）", () => {
    expect(combineBlink(0, 1)).toBe(0);
  });

  it("手动闭眼（0）压过自动值", () => {
    expect(combineBlink(0.8, 0)).toBe(0);
  });

  it("相乘并夹在 [0,1]", () => {
    expect(combineBlink(0.5, 0.5)).toBeCloseTo(0.25);
    expect(combineBlink(5, 5)).toBe(1);
    expect(combineBlink(-1, 1)).toBe(0);
    expect(combineBlink(Number.NaN, 1)).toBe(0);
  });
});

describe("breathOffsets：正弦呼吸", () => {
  it("在幅度内，周期约 3.5s", () => {
    expect(breathOffsets(0, false).bodyY).toBeCloseTo(0);
    expect(breathOffsets(BREATH_PERIOD_SEC / 4, false).bodyY).toBeCloseTo(BREATH_BODY_AMPLITUDE);
    expect(breathOffsets(BREATH_PERIOD_SEC * 0.75, false).bodyY).toBeCloseTo(-BREATH_BODY_AMPLITUDE);
    expect(Math.abs(breathOffsets(1.1, false).headY)).toBeLessThanOrEqual(BREATH_HEAD_AMPLITUDE);
  });

  it("speaking 时幅度减半", () => {
    expect(breathOffsets(BREATH_PERIOD_SEC / 4, true).bodyY).toBeCloseTo(BREATH_BODY_AMPLITUDE / 2);
    expect(breathOffsets(BREATH_PERIOD_SEC / 4, true).headY).toBeCloseTo(BREATH_HEAD_AMPLITUDE / 2);
  });
});

describe("yunaParams：参数映射", () => {
  it("视线 X 取反（VTube 反向映射）", () => {
    const p = yunaParams({ ...base, phase: "thinking" });
    // thinking 的 look.eyeX = -0.3（params.ts），取反后应为 +0.3。
    expect(p.ParamEyeBallX).toBeCloseTo(0.3);
  });

  it("口型三档", () => {
    expect(yunaParams({ ...base, mouth: "closed" }).ParamMouthOpenY).toBe(0);
    expect(yunaParams({ ...base, mouth: "small" }).ParamMouthOpenY).toBe(0.5);
    expect(yunaParams({ ...base, mouth: "open" }).ParamMouthOpenY).toBe(1);
  });

  it("guarded 眼开合上限 0.6、眉压低（S6g-A §4.1：写物理输入 ParamBrowL/R）", () => {
    const p = yunaParams({ ...base, emotion: "guarded", blinkOpen: 1 });
    expect(p.ParamEyeLOpen).toBeCloseTo(GUARDED_EYE_MAX);
    expect(p.ParamEyeROpen).toBeCloseTo(GUARDED_EYE_MAX);
    expect(p.ParamBrowL).toBe(-0.4);
    expect(p.ParamBrowR).toBe(-0.4);
  });
  it("sad：八字眉（左右物理输入不同）+ 嘴角下撇", () => {
    const p = yunaParams({ ...base, emotion: "sad" });
    expect(p.ParamBrowL).toBe(-0.55);
    expect(p.ParamBrowR).toBe(-0.35);
    expect(p.ParamMouthForm).toBe(-1);
  });

  it("sad 眼睛上限低于 calm（更垂的眼皮）", () => {
    const sad = yunaParams({ ...base, emotion: "sad", blinkOpen: 1 });
    const calm = yunaParams({ ...base, emotion: "calm", blinkOpen: 1 });
    expect(sad.ParamEyeLOpen).toBeDefined();
    expect(calm.ParamEyeLOpen).toBeDefined();
    expect(sad.ParamEyeLOpen as number).toBeLessThan(calm.ParamEyeLOpen as number);
    expect(sad.ParamEyeLOpen).toBeCloseTo(EMOTION_EYE_MAX.sad as number);
  });

  it("warm：笑眼 + 脸红 + 嘴角上扬", () => {
    const p = yunaParams({ ...base, emotion: "warm" });
    expect(p.ParamEyeLSmile).toBe(0.6);
    expect(p.ParamEyeRSmile).toBe(0.6);
    expect(p.ParamShy).toBe(1);
    expect(p.ParamMouthForm).toBe(0.7);
  });

  it("calm 与 neutral 都不叠加情绪参数（同模型默认脸）", () => {
    expect(EMOTION_PARAMS.calm).toEqual({});
    expect(EMOTION_PARAMS.neutral).toEqual({});
  });

  it("呼吸叠加在 ParamBodyAngleY / ParamAngleY 上", () => {
    const peak = yunaParams({ ...base, tSec: BREATH_PERIOD_SEC / 4 });
    expect(peak.ParamBodyAngleY).toBeCloseTo(BREATH_BODY_AMPLITUDE);
    expect(peak.ParamAngleY).toBeCloseTo(BREATH_HEAD_AMPLITUDE);
  });

  it("speaking 时呼吸幅度减半", () => {
    const peak = yunaParams({ ...base, phase: "speaking", tSec: BREATH_PERIOD_SEC / 4 });
    expect(peak.ParamBodyAngleY).toBeCloseTo(BREATH_BODY_AMPLITUDE / 2);
  });
});

describe("applyEyeOpen：眨眼开合的最终上限（§1.3）", () => {
  it("blinkOpen=1 时按 EYE_OPEN_MAX 放大（眼睛真正睁开）", () => {
    expect(applyEyeOpen(1, "calm")).toBeCloseTo(EYE_OPEN_MAX);
  });

  it("blinkOpen=0 时完全闭眼", () => {
    expect(applyEyeOpen(0, "calm")).toBe(0);
  });

  it("guarded 上限 0.6", () => {
    expect(applyEyeOpen(1, "guarded")).toBeCloseTo(GUARDED_EYE_MAX);
  });

  it("越界输入被夹在 [0, EYE_OPEN_MAX]", () => {
    expect(applyEyeOpen(-5, "calm")).toBe(0);
    expect(applyEyeOpen(5, "warm")).toBeCloseTo(EYE_OPEN_MAX);
    expect(applyEyeOpen(Number.NaN, "calm")).toBe(0);
  });
});

describe("yunaParams：后置条件（fast-check 属性测试，§1.3）", () => {
  const inputArb = fc.record({
    phase: fc.constantFrom(...PHASES),
    emotion: fc.constantFrom(...EMOTIONS),
    mouth: fc.constantFrom(...MOUTHS),
    blinkOpen: fc.double({ min: -2, max: 3, noNaN: true }),
    tSec: fc.double({ min: -100, max: 1e6, noNaN: true }),
    silentAction: fc.option(fc.constantFrom(...SILENT_ACTIONS), { nil: null }),
    silentActionSinceSec: fc.double({ min: -5, max: 100, noNaN: true }),
    heart: fc.boolean(),
    heartSinceSec: fc.double({ min: -5, max: 100, noNaN: true }),
    look: fc.option(
      fc.record({
        eyeX: fc.double({ min: -5, max: 5, noNaN: true }),
        eyeY: fc.double({ min: -5, max: 5, noNaN: true }),
        headX: fc.double({ min: -90, max: 90, noNaN: true }),
        headY: fc.double({ min: -90, max: 90, noNaN: true }),
        headZ: fc.double({ min: -90, max: 90, noNaN: true }),
      }),
      { nil: undefined },
    ),
  }) as fc.Arbitrary<YunaParamInput>;

  it("任意输入：每个参数都在舒适区间内，且不出现 NaN", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = yunaParams(input);
        for (const [name, value] of Object.entries(out)) {
          if (!Number.isFinite(value)) return false;
          const [min, max] = COMFORT_RANGES[name] ?? DEFAULT_RANGE;
          if (value < min || value > max) return false;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it("任意两组输入：输出键集合完全相同（S6a-fix1 §1 无残留）", () => {
    fc.assert(
      fc.property(inputArb, inputArb, (a, b) => {
        const ka = Object.keys(yunaParams(a)).sort();
        const kb = Object.keys(yunaParams(b)).sort();
        return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
      }),
      { numRuns: 500 },
    );
  });

  it("输出始终包含 EMOTION_KEYS 的并集；calm 时这些键全为 0", () => {
    const out = yunaParams({ ...base, emotion: "calm" });
    for (const key of EMOTION_KEYS) expect(out).toHaveProperty(key);
    for (const key of EMOTION_KEYS) expect(out[key]).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------------
 * S6f §2：四态动作。
 * ---------------------------------------------------------------------------------------------- */

describe("S6f §2：倾听 ≠ 待机（人物上可分辨）", () => {
  it("倾听有身体前倾（ParamBodyAngleY）与头歪（ParamAngleZ），待机没有", () => {
    const listening = yunaParams({ ...base, phase: "listening", phaseSinceSec: LISTEN_TRANSITION_SEC, tSec: 0 });
    const idle = yunaParams({ ...base, phase: "idle", tSec: 0 });
    expect(listening.ParamBodyAngleY).toBeCloseTo(LISTEN_BODY_FORWARD);
    expect(listening.ParamAngleZ).toBeCloseTo(LISTEN_HEAD_TILT_Z);
    expect(idle.ParamBodyAngleY).toBeCloseTo(0);
    expect(idle.ParamAngleZ).toBeCloseTo(0);
    // 两者在人物上可分辨：前倾与头歪至少一项不同。
    expect(listening.ParamBodyAngleY !== idle.ParamBodyAngleY || listening.ParamAngleZ !== idle.ParamAngleZ).toBe(true);
  });

  it("倾听 300ms 内过渡到位（phaseSinceSec=0 时无前倾）", () => {
    const start = yunaParams({ ...base, phase: "listening", phaseSinceSec: 0, tSec: 0 });
    expect(start.ParamBodyAngleY).toBeCloseTo(0);
    expect(start.ParamAngleZ).toBeCloseTo(0);
    const half = yunaParams({ ...base, phase: "listening", phaseSinceSec: LISTEN_TRANSITION_SEC / 2, tSec: 0 });
    expect(half.ParamBodyAngleY as number).toBeGreaterThan(0);
    expect(half.ParamBodyAngleY as number).toBeLessThan(LISTEN_BODY_FORWARD);
  });

  it("倾听每 2–3 秒一次点头（ParamAngleY 有峰值）", () => {
    expect(listenNodOffset(0.1)).toBeGreaterThan(0);
    expect(listenNodOffset(0.2)).toBeCloseTo(LISTEN_NOD_AMPLITUDE);
    expect(listenNodOffset(1)).toBe(0);
    // 周期落在 2–3s。
    expect(LISTEN_NOD_PERIOD_SEC).toBeGreaterThanOrEqual(2);
    expect(LISTEN_NOD_PERIOD_SEC).toBeLessThanOrEqual(3);
    // 一个周期后再次出现峰值。
    expect(listenNodOffset(LISTEN_NOD_PERIOD_SEC + 0.2)).toBeCloseTo(LISTEN_NOD_AMPLITUDE);
  });

  it("倾听看镜头（视线偏移为 0）", () => {
    const p = yunaParams({ ...base, phase: "listening", phaseSinceSec: LISTEN_TRANSITION_SEC });
    expect(p.ParamEyeBallX).toBeCloseTo(0);
    expect(p.ParamEyeBallY).toBeCloseTo(0);
  });
});

describe("S6f §2：思考", () => {
  it("思考头歪向另一侧（与倾听反向）+ 眨眼变慢", () => {
    const thinking = yunaParams({ ...base, phase: "thinking", phaseSinceSec: 0.3, blinkOpen: 1, tSec: 0 });
    expect(thinking.ParamAngleZ).toBeCloseTo(THINK_HEAD_TILT_Z);
    expect(THINK_HEAD_TILT_Z).toBeLessThan(0);
    expect(LISTEN_HEAD_TILT_Z).toBeGreaterThan(0);
    expect(thinking.ParamEyeLOpen as number).toBeLessThanOrEqual(THINK_EYE_MAX);
  });

  it("思考保留现有视线偏开", () => {
    const p = yunaParams({ ...base, phase: "thinking" });
    // thinking 的 look.eyeX=-0.3（params.ts），取反后 ParamEyeBallX=+0.3。
    expect(p.ParamEyeBallX).toBeCloseTo(0.3);
  });
});

describe("S6g-A §4.2/§4.3：待机小动作只剩瞟向一侧", () => {
  it("idleSinceSec > 8 后瞟向一侧（seed=0.1 → 瞟向一侧）", () => {
    const params = idleActionParams(9, 0.1);
    expect(params.ParamEyeBallX).toBeCloseTo(0.3);
  });

  it("seed 落在另一档时不产生任何参数（抱熊 / 耳朵已删）", () => {
    expect(idleActionParams(9, 0.9)).toEqual({});
  });

  it("任何 seed 都不再产出抱熊（ParamPet）或耳朵（ParamEarsLX1/RX1）", () => {
    for (const seed of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      const params = idleActionParams(9, seed);
      expect(params.ParamPet).toBeUndefined();
      expect(params.ParamEarsLX1).toBeUndefined();
      expect(params.ParamEarsRX1).toBeUndefined();
    }
  });

  it("idleSinceSec ≤ 8 无小动作", () => {
    expect(idleActionParams(0, 0.1)).toEqual({});
    expect(idleActionParams(8, 0.1)).toEqual({});
  });
});

describe("S6f §2：说话", () => {
  it("sad → 哭哭（ParamCry）+ 流泪（泪参数）", () => {
    const p = yunaParams({ ...base, phase: "speaking", emotion: "sad", tSec: 1 });
    expect(p.ParamCry).toBe(1);
    // 泪参数键存在。
    expect(p).toHaveProperty("ParamTearL");
    expect(p).toHaveProperty("ParamTearLY");
  });

  it("warm → 现有脸红（ParamShy）", () => {
    const p = yunaParams({ ...base, phase: "speaking", emotion: "warm" });
    expect(p.ParamShy).toBe(1);
  });

  it("首句回话开始时叠加惊讶 1.2 秒，只出现一次", () => {
    expect(speakAmazed(undefined)).toBe(0);
    expect(speakAmazed(0)).toBe(1);
    expect(speakAmazed(SPEAK_AMAZED_SEC - 0.01)).toBe(1);
    expect(speakAmazed(SPEAK_AMAZED_SEC)).toBe(0);
    expect(speakAmazed(5)).toBe(0);
  });
});

describe("S6f §2：silentAction 映射", () => {
  it("drink → 低头 + 闭眼 1 秒", () => {
    expect(SILENT_ACTION_TABLE.drink.durationSec).toBe(1);
    const p = yunaParams({ ...base, silentAction: "drink" });
    expect(p.ParamAngleY).toBe(8);
    expect(p.ParamEyeLOpen).toBe(0);
    expect(p.ParamEyeROpen).toBe(0);
  });

  it("phone → 视线向下 2 秒", () => {
    expect(SILENT_ACTION_TABLE.phone.durationSec).toBe(2);
    const p = yunaParams({ ...base, silentAction: "phone" });
    expect(p.ParamEyeBallY).toBeCloseTo(-0.25);
  });

  it("show_item → 抱熊 3 秒，ParamPet 0→1→0 渐变（S6g-A §4.3）", () => {
    expect(SILENT_ACTION_TABLE.show_item.durationSec).toBe(3);
    // 起点、中途、终点：0 → 1 → 0。
    expect(yunaParams({ ...base, silentAction: "show_item", silentActionSinceSec: 0 }).ParamPet).toBe(0);
    expect(yunaParams({ ...base, silentAction: "show_item", silentActionSinceSec: PET_FADE_SEC }).ParamPet).toBe(1);
    expect(yunaParams({ ...base, silentAction: "show_item", silentActionSinceSec: 1.5 }).ParamPet).toBe(1);
    expect(yunaParams({ ...base, silentAction: "show_item", silentActionSinceSec: 3 }).ParamPet).toBe(0);
  });

  it("非 show_item 的动作不出现抱熊", () => {
    expect(yunaParams({ ...base, silentAction: "drink" }).ParamPet).toBe(0);
    expect(yunaParams({ ...base, silentAction: "glance" }).ParamPet).toBe(0);
  });

  it("glance → 看向一侧 1.5 秒（视线经 clampView，S6g-A §4.4）", () => {
    expect(SILENT_ACTION_TABLE.glance.durationSec).toBe(1.5);
    const p = yunaParams({ ...base, silentAction: "glance" });
    // 视线 X 取反（VTube 反向映射）：look.eyeX=+0.3 → 输出 -0.3。
    expect(p.ParamEyeBallX).toBeCloseTo(-0.3);
    expect(Math.abs(p.ParamEyeBallX as number)).toBeLessThanOrEqual(VIEW_LIMITS.gazeX + 1e-9);
  });
});

describe("S6c-fix1 §8b.2：四种情绪下猫耳朵都可见", () => {
  it("任何情绪都显式写 ParamEarOFF=0（耳朵不关闭）", () => {
    for (const emotion of EMOTIONS) {
      const p = yunaParams({ ...base, emotion });
      expect(p.ParamEarOFF).toBe(0);
    }
  });

  it("任何情绪都不把耳朵相关参数写成隐藏值（不出现耳朵相关键被置为隐藏）", () => {
    for (const emotion of EMOTIONS) {
      const p = yunaParams({ ...base, emotion });
      for (const key of Object.keys(p)) {
        // 只有 ParamEarOFF 是耳朵开关；其余 ParamEars* 由物理驱动，不应在此出现。
        if (/^ParamEars/i.test(key)) expect(p[key]).toBeUndefined();
      }
    }
  });
});

describe("S6g-A §3.2：hearts 特效 ParamHeart", () => {
  it("heart=false 时 ParamHeart=0", () => {
    expect(yunaParams({ ...base }).ParamHeart).toBe(0);
  });

  it("heart=true 且未给秒数时直接为 1", () => {
    expect(yunaParams({ ...base, heart: true }).ParamHeart).toBe(1);
  });

  it("heart=true 时 0.4s 渐入", () => {
    expect(yunaParams({ ...base, heart: true, heartSinceSec: 0 }).ParamHeart).toBe(0);
    expect(yunaParams({ ...base, heart: true, heartSinceSec: HEART_FADE_SEC / 2 }).ParamHeart).toBeCloseTo(0.5);
    expect(yunaParams({ ...base, heart: true, heartSinceSec: HEART_FADE_SEC }).ParamHeart).toBe(1);
    expect(yunaParams({ ...base, heart: true, heartSinceSec: 5 }).ParamHeart).toBe(1);
  });
});

describe("S6g-A §4.3：petGradient 0→1→0", () => {
  it("端点与中途", () => {
    expect(petGradient(0, 3)).toBe(0);
    expect(petGradient(-1, 3)).toBe(0);
    expect(petGradient(PET_FADE_SEC / 2, 3)).toBeCloseTo(0.5);
    expect(petGradient(PET_FADE_SEC, 3)).toBe(1);
    expect(petGradient(1.5, 3)).toBe(1);
    expect(petGradient(3 - PET_FADE_SEC / 2, 3)).toBeCloseTo(0.5);
    expect(petGradient(3, 3)).toBe(0);
    expect(petGradient(4, 3)).toBe(0);
  });
});

describe("S6f §2：流泪采样（tearParams）", () => {
  it("泪参数在 5.2s 周期内循环，左右错开", () => {
    const a = tearParams(0);
    const b = tearParams(5.2);
    expect(a.ParamTearL).toBeCloseTo(b.ParamTearL as number);
    // 左泪先于右泪：t=1 时左泪已在下流，右泪未开始。
    const left = tearParams(1);
    expect(left.ParamTearLY as number).toBeGreaterThan(0);
    expect(left.ParamTearRY).toBe(0);
  });

  it("泪参数范围 [0,2]，无负值", () => {
    for (const t of [0, 0.5, 1, 2, 2.44, 3, 4.77, 5]) {
      for (const value of Object.values(tearParams(t))) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe("S6f §2：禁止参数与水印参数（fast-check 属性测试）", () => {
  const inputArb = fc.record({
    phase: fc.constantFrom(...PHASES),
    emotion: fc.constantFrom(...EMOTIONS),
    mouth: fc.constantFrom(...MOUTHS),
    blinkOpen: fc.double({ min: -2, max: 3, noNaN: true }),
    tSec: fc.double({ min: -100, max: 1e6, noNaN: true }),
    phaseSinceSec: fc.double({ min: -1, max: 100, noNaN: true }),
    idleSinceSec: fc.double({ min: -1, max: 1000, noNaN: true }),
    firstSpokeSinceSec: fc.option(fc.double({ min: -1, max: 100, noNaN: true }), { nil: undefined }),
    silentAction: fc.option(fc.constantFrom(...SILENT_ACTIONS), { nil: null }),
    silentActionSinceSec: fc.double({ min: -5, max: 100, noNaN: true }),
    heart: fc.boolean(),
    heartSinceSec: fc.double({ min: -5, max: 100, noNaN: true }),
    accent: fc.option(fc.constantFrom(...ACCENTS), { nil: null }),
    accentSinceSec: fc.double({ min: -5, max: 100, noNaN: true }),
    accentEndedSinceSec: fc.option(fc.double({ min: -5, max: 100, noNaN: true }), { nil: undefined }),
    seed: fc.double({ min: -1, max: 2, noNaN: true }),
    look: fc.option(
      fc.record({
        eyeX: fc.double({ min: -5, max: 5, noNaN: true }),
        eyeY: fc.double({ min: -5, max: 5, noNaN: true }),
        headX: fc.double({ min: -90, max: 90, noNaN: true }),
        headY: fc.double({ min: -90, max: 90, noNaN: true }),
        headZ: fc.double({ min: -90, max: 90, noNaN: true }),
      }),
      { nil: undefined },
    ),
  }) as fc.Arbitrary<YunaParamInput>;

  it("任意输入：禁止参数与 Param1–Param10 恒为 0", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = yunaParams(input);
        for (const key of FORBIDDEN_KEYS) {
          if (out[key] !== 0) return false;
        }
        for (let i = 1; i <= 10; i += 1) {
          if (out[`Param${i}`] !== 0) return false;
        }
        // D47：ParamFlyHead2 始终 0（不由任何 accent 写）。
        if (out.ParamFlyHead2 !== 0) return false;
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it("任意输入：视线 / 转头不超过 VIEW_LIMITS", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const out = yunaParams(input);
        // 视线（模型范围 ±1，产品上限 VIEW_LIMITS.gazeX/Y 经 clampView 施加；X 取反不改变绝对值）。
        if (Math.abs(out.ParamEyeBallX as number) > VIEW_LIMITS.gazeX + 1e-9) return false;
        if (Math.abs(out.ParamEyeBallY as number) > VIEW_LIMITS.gazeY + 1e-9) return false;
        // 转头（度）：clampView 限到 VIEW_LIMITS.headDeg；倾听 / 思考的头歪与呼吸叠加后可能超过，但必须在模型舒适区 ±30 内。
        if (Math.abs(out.ParamAngleX as number) > 30) return false;
        if (Math.abs(out.ParamAngleY as number) > 30) return false;
        if (out.ParamAngleZ !== undefined && Math.abs(out.ParamAngleZ as number) > 30) return false;
        return true;
      }),
      { numRuns: 1000 },
    );
  });
});

describe("D47 §3：accent 与已有效果取最大值合并", () => {
  it("accent=null 时 accent 键全部为 0（键仍存在）", () => {
    const out = yunaParams({ ...base });
    for (const key of ACCENT_KEYS) expect(out).toHaveProperty(key);
    for (const key of ACCENT_KEYS) expect(out[key]).toBe(0);
  });

  it("accent 激活 + 渐入到稳态：主参数为 1", () => {
    for (const accent of ACCENTS) {
      const out = yunaParams({ ...base, accent, accentSinceSec: 0.4 });
      expect(out[ACCENT_PARAM_OF(accent)]).toBeCloseTo(1);
    }
  });

  it("accent 渐入中间按权重缩放", () => {
    const out = yunaParams({ ...base, accent: "love", accentSinceSec: 0.2 });
    expect(out.ParamLove).toBeCloseTo(0.5);
  });

  it("warm 自带 ParamShy 与 accent=shy 取最大值（不叠加、不变小）", () => {
    const out = yunaParams({ ...base, emotion: "warm", accent: "shy", accentSinceSec: 0.1 });
    // warm 的 ParamShy=1；accent 权重 0.25 → 取 max = 1。
    expect(out.ParamShy).toBe(1);
  });

  it("sad 自带 ParamCry 与 accent=cry 取最大值", () => {
    const out = yunaParams({ ...base, emotion: "sad", tSec: 1, accent: "cry", accentSinceSec: 1 });
    expect(out.ParamCry).toBe(1);
    // 泪参数：sad 与 accent cry 取 max，仍在下流（t=1 左泪已在下流）。
    expect(out.ParamTearLY as number).toBeGreaterThan(0);
  });

  it("accentEndedSinceSec 有值 → 0.4s 渐出", () => {
    const until = 2;
    expect(yunaParams({ ...base, accent: "love", accentSinceSec: until, accentEndedSinceSec: until }).ParamLove).toBe(1);
    expect(
      yunaParams({ ...base, accent: "love", accentSinceSec: until + 0.2, accentEndedSinceSec: until }).ParamLove,
    ).toBeCloseTo(0.5);
    expect(
      yunaParams({ ...base, accent: "love", accentSinceSec: until + 0.4, accentEndedSinceSec: until }).ParamLove,
    ).toBe(0);
  });

  it("fly_head 写 ParamFlyHead，ParamFlyHead2 始终 0", () => {
    const out = yunaParams({ ...base, accent: "fly_head", accentSinceSec: 0.4 });
    expect(out.ParamFlyHead).toBe(1);
    expect(out.ParamFlyHead2).toBe(0);
  });
});

/** 测试辅助：accent → 主参数名（与 accentParams 的 ACCENT_PARAM 一致）。 */
function ACCENT_PARAM_OF(accent: Accent): string {
  const map: Record<Accent, string> = {
    love: "ParamLove",
    heart: "ParamHeart",
    shy: "ParamShy",
    amazed: "ParamAmazed",
    cry: "ParamCry",
    angry: "ParamAngry",
    black: "ParamBlack",
    dark: "ParamDark",
    fly_head: "ParamFlyHead",
    fly_pet: "ParamFlyPet",
  };
  return map[accent];
}
