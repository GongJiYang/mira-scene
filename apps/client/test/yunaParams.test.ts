import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  approach,
  approachParams,
  applyEyeOpen,
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
  GUARDED_EYE_MAX,
  yunaParams,
  type YunaEmotion,
  type YunaParamInput,
} from "../src/render/live2d/yunaParams";
import type { MouthShape, StagePhaseKind } from "../src/state/performance";

const PHASES: StagePhaseKind[] = ["idle", "listening", "thinking", "speaking", "error"];
const EMOTIONS: YunaEmotion[] = ["calm", "guarded", "sad", "warm", "neutral"];
const MOUTHS: MouthShape[] = ["closed", "small", "open"];

const base: YunaParamInput = { phase: "idle", emotion: "calm", mouth: "closed", blinkOpen: 1, tSec: 0 };

describe("clampParam：舒适区间是唯一出处", () => {
  it("已知参数用 COMFORT_RANGES，未知参数用 DEFAULT_RANGE", () => {
    expect(clampParam("ParamAngleX", 100)).toBe(30);
    expect(clampParam("ParamAngleX", -100)).toBe(-30);
    expect(clampParam("ParamMouthOpenY", 5)).toBe(2.1);
    expect(clampParam("ParamBrowLY", 5)).toBe(1);
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

  it("guarded 眼开合上限 0.6、眉压低", () => {
    const p = yunaParams({ ...base, emotion: "guarded", blinkOpen: 1 });
    expect(p.ParamEyeLOpen).toBeCloseTo(GUARDED_EYE_MAX);
    expect(p.ParamEyeROpen).toBeCloseTo(GUARDED_EYE_MAX);
    expect(p.ParamBrowLY).toBe(-0.4);
    expect(p.ParamBrowRY).toBe(-0.4);
  });
  it("sad：八字眉方向 + 嘴角下撇（S6a-fix1 §5 加大）", () => {
    const p = yunaParams({ ...base, emotion: "sad" });
    expect(p.ParamBrowLAngle).toBe(-1);
    expect(p.ParamBrowRAngle).toBe(1);
    expect(p.ParamBrowLY).toBe(-0.8);
    expect(p.ParamBrowRY).toBe(-0.8);
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
