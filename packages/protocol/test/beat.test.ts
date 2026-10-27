import { describe, expect, it } from "vitest";
import { beatSchema, parseBeatLenient, type Beat, type BeatParseResult } from "../src";

const baseBeat: Beat = {
  seq: 0,
  say: "今晚的雨真大。",
  emotion: "calm",
  hands: "cup",
  action: null,
  camera: null,
  fx: null,
  media: null,
  story: null,
};

describe("parseBeatLenient", () => {
  it("合法 beat 原样保留且不产生 warning", () => {
    const result = parseBeatLenient(baseBeat);
    expect(result.warnings).toEqual([]);
    expect(result.beat).toEqual(baseBeat);
    expect(beatSchema.safeParse(result.beat).success).toBe(true);
  });

  it("空字符串台词是合法的无声动作 beat", () => {
    const result = parseBeatLenient({ ...baseBeat, say: "" });
    expect(result.warnings).toEqual([]);
    expect(result.beat.say).toBe("");
  });

  const enumCases: Array<{ field: string; patch: Partial<Record<keyof Beat, unknown>>; expected: Partial<Beat> }> = [
    { field: "emotion", patch: { emotion: "angry" }, expected: { emotion: "neutral" } },
    { field: "hands", patch: { hands: "stand" }, expected: { hands: "cup" } },
    { field: "action", patch: { action: "wave" }, expected: { action: null } },
    { field: "camera", patch: { camera: "zoom" }, expected: { camera: null } },
    { field: "fx", patch: { fx: "snow" }, expected: { fx: null } },
    {
      field: "media.type",
      patch: { media: { type: "gif", id: "photo_letters" } },
      expected: { media: null },
    },
    {
      field: "story.advance",
      patch: { story: { advance: "climax" } },
      expected: { story: null },
    },
  ];

  it.each(enumCases)("非法 $field 降级并写一条 warning", ({ field, patch, expected }) => {
    const result = parseBeatLenient({ ...baseBeat, ...patch });
    expect(result.beat).toEqual({ ...baseBeat, ...expected });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain(field.split(".")[0] ?? field);
  });

  it("旧字段名 pose 不再被当作 hands 读取", () => {
    const result = parseBeatLenient({ ...baseBeat, pose: "polaroid", hands: undefined });
    expect(result.beat.hands).toBe("cup");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain("hands");
  });

  it("合法的 media / story / action / camera / fx 被保留", () => {
    const full: Beat = {
      ...baseBeat,
      action: "drink",
      camera: "close_up",
      fx: "warm_glow",
      media: { type: "video", id: "photo_letters" },
      story: { advance: "reveal" },
    };
    const result = parseBeatLenient(full);
    expect(result.warnings).toEqual([]);
    expect(result.beat).toEqual(full);
  });

  it.each([-1, 1.5, "3", null, undefined])("非法 seq %s 修正为 0 并写 warning", (seq) => {
    const result = parseBeatLenient({ ...baseBeat, seq });
    expect(result.beat.seq).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain("seq");
  });

  it("seq 为 0 合法，不产生 warning", () => {
    expect(parseBeatLenient({ ...baseBeat, seq: 0 }).warnings).toEqual([]);
  });

  it.each([42, null, undefined, true, ["台词"]])("非法 say %s 回退为空串并写 warning", (say) => {
    const result = parseBeatLenient({ ...baseBeat, say });
    expect(result.beat.say).toBe("");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain("say");
  });

  it.each([null, undefined, "not-an-object", 42, ["beat"]])(
    "非对象输入 %s 不抛错，返回 neutral/cup 空 beat 和一条 warning",
    (input) => {
      let result: BeatParseResult | undefined;
      expect(() => {
        result = parseBeatLenient(input);
      }).not.toThrow();
      expect(result?.beat).toEqual({
        seq: 0,
        say: "",
        emotion: "neutral",
        hands: "cup",
        action: null,
        camera: null,
        fx: null,
        media: null,
        story: null,
      });
      expect(result?.warnings).toHaveLength(1);
    },
  );
});
