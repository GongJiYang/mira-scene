import { afterEach, describe, expect, it } from "vitest";
import {
  composePreview,
  PREVIEW_ACCENT_HOLD_SEC,
  PREVIEW_EMOTION_SEC,
  previewDisabled,
  previewDurationSec,
  usePreviewStore,
  type PreviewBase,
} from "../src/live/previewStore";
import { ACCENT_FADE_SEC } from "../src/render/live2d/accentParams";
import { LOCAL_ACTION_DURATION_SEC } from "../src/render/live2d/localActions";

const baseVisual: PreviewBase["visual"] = {
  emotion: "calm",
  hands: "cup",
  action: null,
  camera: null,
  fx: null,
  accent: null,
};

const base = (over: Partial<PreviewBase> = {}): PreviewBase => ({
  emotion: "calm",
  visual: baseVisual,
  phase: "idle",
  ...over,
});

afterEach(() => {
  usePreviewStore.getState().endPreview();
});

describe("S6m §3：previewDisabled", () => {
  it("thinking / speaking 时整组禁用；idle / listening / error 可用", () => {
    expect(previewDisabled("thinking")).toBe(true);
    expect(previewDisabled("speaking")).toBe(true);
    expect(previewDisabled("idle")).toBe(false);
    expect(previewDisabled("listening")).toBe(false);
    expect(previewDisabled("error")).toBe(false);
  });
});

describe("S6m §3：previewDurationSec", () => {
  it("情绪 3s、表情 2s、新动作按各自时长、现有动作按 SILENT_ACTION_TABLE", () => {
    expect(previewDurationSec({ kind: "emotion", value: "warm" })).toBe(PREVIEW_EMOTION_SEC);
    expect(previewDurationSec({ kind: "accent", value: "love" })).toBe(PREVIEW_ACCENT_HOLD_SEC);
    expect(previewDurationSec({ kind: "action", value: "wave" })).toBe(LOCAL_ACTION_DURATION_SEC.wave);
    expect(previewDurationSec({ kind: "action", value: "show_item" })).toBe(3);
  });
});

describe("S6m §3：composePreview", () => {
  it("无预览 / 预览为 null → 原样（不改情绪、无叠加参数）", () => {
    const out = composePreview(base(), null, 1000);
    expect(out.emotion).toBe("calm");
    expect(out.params).toEqual({});
    expect(out.postPhysics).toBeUndefined();
  });

  it("情绪预览：情绪优先，未到期保持预览情绪", () => {
    const preview = { item: { kind: "emotion", value: "warm" } as const, startedAtMs: 1000 };
    const mid = composePreview(base(), preview, 1000 + 1000);
    expect(mid.emotion).toBe("warm");
    // 到期恢复。
    const ended = composePreview(base(), preview, 1000 + PREVIEW_EMOTION_SEC * 1000);
    expect(ended.emotion).toBe("calm");
  });

  it("表情预览：按 accent 规则渐入 / 渐出（0.4s）", () => {
    const preview = { item: { kind: "accent", value: "love" } as const, startedAtMs: 0 };
    // 渐入中点 → 0.5。
    const mid = composePreview(base(), preview, (ACCENT_FADE_SEC / 2) * 1000);
    expect(mid.params.ParamLove).toBeCloseTo(0.5);
    // 保持期稳态 → 1。
    const hold = composePreview(base(), preview, (PREVIEW_ACCENT_HOLD_SEC - 0.1) * 1000);
    expect(hold.params.ParamLove).toBeCloseTo(1);
    // 渐出之后 → 空。
    const ended = composePreview(base(), preview, (PREVIEW_ACCENT_HOLD_SEC + ACCENT_FADE_SEC + 0.01) * 1000);
    expect(ended.params).toEqual({});
  });

  it("动作预览（wave）：给物理后覆盖，权重随时间渐入", () => {
    const preview = { item: { kind: "action", value: "wave" } as const, startedAtMs: 0 };
    const early = composePreview(base(), preview, 50);
    expect(early.postPhysics?.weight).toBeGreaterThan(0);
    expect(early.postPhysics?.weight).toBeLessThan(1);
    const mid = composePreview(base(), preview, (LOCAL_ACTION_DURATION_SEC.wave / 2) * 1000);
    expect(mid.postPhysics?.weight).toBe(1);
    // 到期 → 无覆盖。
    const ended = composePreview(base(), preview, LOCAL_ACTION_DURATION_SEC.wave * 1000);
    expect(ended.postPhysics).toBeUndefined();
  });

  it("动作预览（sway）：给物理输入参数，不含物理后覆盖", () => {
    const preview = { item: { kind: "action", value: "sway" } as const, startedAtMs: 0 };
    const mid = composePreview(base(), preview, (LOCAL_ACTION_DURATION_SEC.sway / 2) * 1000);
    expect(mid.postPhysics).toBeUndefined();
    expect(mid.params).toHaveProperty("ParamBodyAngleZ");
    expect(mid.params).toHaveProperty("ParamAngleZ");
  });

  it("speaking 时拒绝预览", () => {
    const preview = { item: { kind: "emotion", value: "warm" } as const, startedAtMs: 1000 };
    const out = composePreview(base({ phase: "speaking" }), preview, 1500);
    expect(out.emotion).toBe("calm");
    expect(out.params).toEqual({});
  });

  it("不改 base.visual（A 状态机不受影响）", () => {
    const preview = { item: { kind: "accent", value: "love" } as const, startedAtMs: 0 };
    const before = { ...baseVisual };
    composePreview(base(), preview, 300);
    expect(baseVisual).toEqual(before);
  });
});
