import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EAR_FLICK_BURST_SEC,
  LOCAL_ACTION_DURATION_SEC,
  localActionSample,
  SWAY_BODY_AMPLITUDE,
  SWAY_HEAD_AMPLITUDE,
  TAIL_AMPLITUDE,
  WAVE_BOOM_RAISE,
  WAVE_FOREARM_RAISE,
  WAVE_TURN_AMPLITUDE,
  type LocalActionId,
} from "../src/render/live2d/localActions";
import { COMFORT_RANGES, DEFAULT_RANGE } from "../src/render/live2d/yunaParams";
import { postPhysicsParams } from "../src/render/live2d/postPhysics";

const ACTIONS: LocalActionId[] = ["wave", "tail_wag", "ear_flick", "sway"];

/**
 * 测试替身：模型里手 / 尾 / 耳参数范围为 [-1,1]（实测见 s6m-report.md）；
 * 角度参数经 COMFORT_RANGES / DEFAULT_RANGE。
 */
const MOCK_RANGES: Record<string, readonly [number, number]> = {
  ...COMFORT_RANGES,
  ParamHandR: [-1, 1],
  ParamHandTurnR: [-1, 1],
  ParamBoomR: [-1, 1],
  ParamForeamR: [-1, 1],
  ParamTailX1: [-1, 1],
  ParamTailX2: [-1, 1],
  ParamTailX3: [-1, 1],
  ParamEarsLY2: [-1, 1],
  ParamEarsRY2: [-1, 1],
};

const rangeOf = (name: string): readonly [number, number] => MOCK_RANGES[name] ?? DEFAULT_RANGE;

describe("S6m §2：新动作时长符合表", () => {
  it("wave 2.0 / tail_wag 2.5 / ear_flick 0.8 / sway 2.5", () => {
    expect(LOCAL_ACTION_DURATION_SEC.wave).toBe(2.0);
    expect(LOCAL_ACTION_DURATION_SEC.tail_wag).toBe(2.5);
    expect(LOCAL_ACTION_DURATION_SEC.ear_flick).toBe(0.8);
    expect(LOCAL_ACTION_DURATION_SEC.sway).toBe(2.5);
  });
});

describe("S6m §2：四个动作曲线起止为 0、峰值在范围内", () => {
  it("越界时间（负 / 时长及以后）不写任何参数", () => {
    for (const action of ACTIONS) {
      const dur = LOCAL_ACTION_DURATION_SEC[action];
      for (const t of [-1, dur, dur + 1]) {
        const s = localActionSample(action, t);
        expect(Object.keys(s.postPhysics)).toHaveLength(0);
        expect(Object.keys(s.input)).toHaveLength(0);
      }
    }
  });

  it("起止权重为 0（端点不产生物理后覆盖）", () => {
    for (const action of ACTIONS) {
      const dur = LOCAL_ACTION_DURATION_SEC[action];
      expect(postPhysicsParams(action, 0).weight).toBe(0);
      expect(postPhysicsParams(action, 0).target).toEqual({});
      expect(postPhysicsParams(action, dur).target).toEqual({});
    }
  });

  it("§4：wave 抬起整条手臂（大臂 + 小臂 + 手），手掌摆动 ≤ 60% 范围", () => {
    const mid = localActionSample("wave", LOCAL_ACTION_DURATION_SEC.wave / 2);
    // 只抬「手」看不出挥手，必须同时抬大臂 / 小臂（都是物理输出，经 postPhysics 才有效）。
    expect(mid.postPhysics.ParamBoomR).toBeCloseTo(WAVE_BOOM_RAISE);
    expect(mid.postPhysics.ParamForeamR).toBeCloseTo(WAVE_FOREARM_RAISE);
    expect(mid.postPhysics.ParamHandR).toBeGreaterThan(0.9);
    expect(Math.abs(mid.postPhysics.ParamHandTurnR as number)).toBeLessThanOrEqual(WAVE_TURN_AMPLITUDE + 1e-9);
  });

  it("tail_wag：三节相位差，幅度 ≤ 70% 范围", () => {
    const s = localActionSample("tail_wag", 0.3);
    for (const k of ["ParamTailX1", "ParamTailX2", "ParamTailX3"]) {
      expect(Math.abs(s.postPhysics[k] as number)).toBeLessThanOrEqual(TAIL_AMPLITUDE + 1e-9);
    }
    // 相位差：同一时刻三节不完全相同。
    expect(s.postPhysics.ParamTailX1).not.toBe(s.postPhysics.ParamTailX2);
  });

  it("ear_flick：弹动冲高再回，两次（0.15s 内冲高）", () => {
    const peak = localActionSample("ear_flick", EAR_FLICK_BURST_SEC / 2);
    expect(peak.postPhysics.ParamEarsLY2).toBeCloseTo(1);
    expect(peak.postPhysics.ParamEarsRY2).toBeCloseTo(1);
    // 一次弹动刚结束回到 0。
    expect(localActionSample("ear_flick", EAR_FLICK_BURST_SEC + 0.02).postPhysics.ParamEarsLY2).toBe(0);
    // 0.8s 内共两次：第二次弹动起点在 0.4s。
    const second = localActionSample("ear_flick", 0.4 + EAR_FLICK_BURST_SEC / 2);
    expect(second.postPhysics.ParamEarsLY2).toBeGreaterThan(0.9);
  });

  it("sway：写物理输入 ParamBodyAngleZ / ParamAngleZ，且在 ±6 / ±4 内并已经 clampParam", () => {
    let sawBody = false;
    let sawHead = false;
    for (let t = 0; t < LOCAL_ACTION_DURATION_SEC.sway; t += 0.05) {
      const s = localActionSample("sway", t);
      expect(Object.keys(s.postPhysics)).toHaveLength(0);
      const body = s.input.ParamBodyAngleZ;
      const head = s.input.ParamAngleZ;
      expect(Math.abs(body as number)).toBeLessThanOrEqual(SWAY_BODY_AMPLITUDE + 1e-9);
      expect(Math.abs(head as number)).toBeLessThanOrEqual(SWAY_HEAD_AMPLITUDE + 1e-9);
      // 已在舒适区间内（clampParam 已施加）。
      expect(Math.abs(body as number)).toBeLessThanOrEqual(rangeOf("ParamBodyAngleZ")[1]);
      expect(Math.abs(head as number)).toBeLessThanOrEqual(rangeOf("ParamAngleZ")[1]);
      if (Math.abs(body as number) > 1) sawBody = true;
      if (Math.abs(head as number) > 1) sawHead = true;
    }
    expect(sawBody).toBe(true);
    expect(sawHead).toBe(true);
  });
});

describe("S6m §2：属性测试（fast-check）——写入值都在模型范围内", () => {
  it("任意动作 × 任意时刻：postPhysics / input 值都在替身范围，且不含水印参数", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ACTIONS),
        fc.double({ min: -0.5, max: 3, noNaN: true }),
        (action, t) => {
          const s = localActionSample(action, t);
          for (const group of [s.postPhysics, s.input]) {
            for (const [name, value] of Object.entries(group)) {
              if (!Number.isFinite(value)) return false;
              const [min, max] = rangeOf(name);
              if (value < min || value > max) return false;
              // 水印参数 Param1–Param10 恒不出现。
              if (/^Param\d+$/.test(name)) return false;
            }
          }
          return true;
        },
      ),
      { numRuns: 1000 },
    );
  });
});
