import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { detectSceneRequest } from "../src/scene/detect";
import { parseSceneSpec } from "../src/scene/spec";
import { composeScenePrompt, SCENE_STYLE_LOCK } from "../src/scene/prompt";
import { admitSceneJob, sceneJobReducer, initialSceneJobState, SCENE_COOLDOWN_MS, SCENE_MAX_JOBS } from "../src/scene/job";
import { testPack } from "./helpers/pack";

const TRIGGER = testPack("yuna").sceneTriggerPattern;

describe("sceneTriggers 表驱动契约（freeze-fix2 §1）", () => {
  // 用真实 content.json 编译出的正则（testPack 从 characters/yuna 加载）。
  const pattern = testPack("yuna").sceneTriggerPattern;

  const mustHit = [
    "带我去海边吧",
    "换个背景",
    "背景换成雪山",
    "我们去海边吧",
    "一起去游乐园吧",
    "去海边看看",
    "想看你在樱花树下",
    "换个地方聊",
  ];

  const mustNotHit = [
    "嗯，去睡吧",
    "去睡觉吧",
    "早点去休息吧",
    "快去吃饭吧",
    "去洗澡吧",
    "你去忙吧",
    "我去倒杯水",
    "去吧",
    "那你去吧",
  ];

  it.each(mustHit)("必须命中：%s", (text) => {
    expect(detectSceneRequest(text, pattern).hit).toBe(true);
  });

  it.each(mustNotHit)("必须不命中：%s", (text) => {
    expect(detectSceneRequest(text, pattern).hit).toBe(false);
  });
});

describe("detectSceneRequest（S6c §1）", () => {
  it("命中关键词", () => {
    // 注：「换到海边吧」不命中（任务说明 §1 的 regex 原样如此，e2e 用「换背景到海边」）。
    expect(detectSceneRequest("换个背景", TRIGGER).hit).toBe(true);
    expect(detectSceneRequest("带我去海边", TRIGGER).hit).toBe(true);
    expect(detectSceneRequest("想看你在雨中", TRIGGER).hit).toBe(true);
    expect(detectSceneRequest("去海边看看吧", TRIGGER).hit).toBe(true);
    expect(detectSceneRequest("换背景", TRIGGER).hit).toBe(true);
    expect(detectSceneRequest("换场景", TRIGGER).hit).toBe(true);
    expect(detectSceneRequest("背景换成海边", TRIGGER).hit).toBe(true);
    expect(detectSceneRequest("场景换成雨夜", TRIGGER).hit).toBe(true);
  });

  it("不命中", () => {
    expect(detectSceneRequest("你好", TRIGGER).hit).toBe(false);
    expect(detectSceneRequest("今天天气不错", TRIGGER).hit).toBe(false);
    expect(detectSceneRequest("背景很好看", TRIGGER).hit).toBe(false);
  });

  it("raw 原样返回", () => {
    const result = detectSceneRequest("换到海边吧", TRIGGER);
    expect(result.raw).toBe("换到海边吧");
  });
});

describe("parseSceneSpec（S6c §2）", () => {
  it("解析合法 spec", () => {
    const raw = JSON.stringify({
      accept: true,
      location: "a quiet sandy beach",
      time: "sunset",
      lighting: "warm low sun",
      props: ["a blanket", "a lantern"],
      palette: "lavender, pink",
      mood: "calm",
      label: "黄昏海边",
      note: "观众把背景换成了黄昏的海边",
    });
    const result = parseSceneSpec(raw);
    expect(result.kind).toBe("spec");
    if (result.kind === "spec") {
      expect(result.spec.label).toBe("黄昏海边");
      expect(result.spec.location).toBe("a quiet sandy beach");
    }
  });

  it("解析拒绝", () => {
    const raw = JSON.stringify({ accept: false, label: "", note: "这个不行哦" });
    const result = parseSceneSpec(raw);
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.note).toBe("这个不行哦");
  });

  it("非法 JSON → invalid", () => {
    expect(parseSceneSpec("not json").kind).toBe("invalid");
    expect(parseSceneSpec("").kind).toBe("invalid");
    expect(parseSceneSpec(123).kind).toBe("invalid");
  });

  it("缺字段 → invalid", () => {
    const raw = JSON.stringify({ accept: true, location: "beach" });
    expect(parseSceneSpec(raw).kind).toBe("invalid");
  });

  it("props 不足 2 个 → invalid", () => {
    const raw = JSON.stringify({
      accept: true,
      location: "beach",
      time: "sunset",
      lighting: "warm",
      props: ["one"],
      palette: "pink",
      mood: "calm",
      label: "海边",
      note: "note",
    });
    expect(parseSceneSpec(raw).kind).toBe("invalid");
  });

  it("label 超过 6 字 → invalid", () => {
    const raw = JSON.stringify({
      accept: true,
      location: "beach",
      time: "sunset",
      lighting: "warm",
      props: ["a", "b"],
      palette: "pink",
      mood: "calm",
      label: "这是一个非常长的场景名",
      note: "note",
    });
    expect(parseSceneSpec(raw).kind).toBe("invalid");
  });

  it("带代码块围栏也能解析", () => {
    const raw = "```json\n" + JSON.stringify({
      accept: true,
      location: "beach",
      time: "sunset",
      lighting: "warm",
      props: ["a", "b"],
      palette: "pink",
      mood: "calm",
      label: "海边",
      note: "note",
    }) + "\n```";
    expect(parseSceneSpec(raw).kind).toBe("spec");
  });
});

describe("composeScenePrompt（S6c §3）", () => {
  const pack = testPack("yuna");
  const spec = {
    accept: true as const,
    location: "a quiet sandy beach",
    time: "sunset",
    lighting: "warm low sun",
    props: ["a blanket", "a lantern"],
    palette: "lavender",
    mood: "calm",
    label: "黄昏海边",
    note: "note",
  };

  it("包含构图锁与画风锁原文", () => {
    const { prompt } = composeScenePrompt(spec, pack, "desktop");
    expect(prompt).toContain(pack.sceneLock);
    expect(prompt).toContain(SCENE_STYLE_LOCK);
  });

  it("desktop 尺寸 1536x1024", () => {
    expect(composeScenePrompt(spec, pack, "desktop").size).toBe("1536x1024");
  });

  it("mobile 尺寸 1024x1536 且加构图提示", () => {
    const { prompt, size } = composeScenePrompt(spec, pack, "mobile");
    expect(size).toBe("1024x1536");
    expect(prompt).toContain("Vertical composition, the cushion/table in the lower-middle area.");
  });

  it("spec 字段截断到 200 字符", () => {
    const longSpec = { ...spec, location: "x".repeat(300) };
    const { prompt } = composeScenePrompt(longSpec, pack, "desktop");
    expect(prompt).not.toContain("x".repeat(201));
  });

  it("fast-check：任意 spec 字段（含注入式文本）都不缺少构图锁与画风锁", () => {
    fc.assert(
      fc.property(
        fc.record({
          location: fc.string({ maxLength: 500 }),
          time: fc.string({ maxLength: 500 }),
          lighting: fc.string({ maxLength: 500 }),
          props: fc.array(fc.string({ maxLength: 500 }), { minLength: 2, maxLength: 4 }),
          palette: fc.string({ maxLength: 500 }),
          mood: fc.string({ maxLength: 500 }),
          label: fc.string({ minLength: 1, maxLength: 6 }),
          note: fc.string(),
        }),
        (rawSpec) => {
          const spec = { ...rawSpec, accept: true as const };
          const { prompt } = composeScenePrompt(spec, pack, "desktop");
          return prompt.includes(pack.sceneLock) && prompt.includes(SCENE_STYLE_LOCK);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("fast-check：注入式文本不影响构图锁与画风锁", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        (injection) => {
          const spec = {
            accept: true as const,
            location: injection,
            time: "sunset",
            lighting: "warm",
            props: ["a", "b"],
            palette: "pink",
            mood: "calm",
            label: "海边",
            note: "note",
          };
          const { prompt } = composeScenePrompt(spec, pack, "desktop");
          return prompt.includes(pack.sceneLock) && prompt.includes(SCENE_STYLE_LOCK);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("sceneJobReducer（S6c §4）", () => {
  it("idle → writing → generating → ready", () => {
    let state = initialSceneJobState();
    state = sceneJobReducer(state, { type: "request", jobId: "j1", at: 0 });
    expect(state.current?.status).toBe("writing");
    expect(state.used).toBe(1);
    state = sceneJobReducer(state, { type: "written", jobId: "j1", label: "海边", at: 1000 });
    expect(state.current?.status).toBe("generating");
    state = sceneJobReducer(state, { type: "ready", jobId: "j1", urls: { desktop: "a", mobile: "b" }, at: 2000 });
    expect(state.current?.status).toBe("ready");
    expect(state.lastFinishedAt).toBe(2000);
  });

  it("同时只允许一个任务", () => {
    let state = initialSceneJobState();
    state = sceneJobReducer(state, { type: "request", jobId: "j1", at: 0 });
    state = sceneJobReducer(state, { type: "request", jobId: "j2", at: 100 });
    expect(state.current?.jobId).toBe("j1");
    expect(state.used).toBe(1);
  });

  it("冷却 45 秒内不可发起", () => {
    let state = initialSceneJobState();
    state = sceneJobReducer(state, { type: "request", jobId: "j1", at: 0 });
    state = sceneJobReducer(state, { type: "written", jobId: "j1", label: "海边", at: 500 });
    state = sceneJobReducer(state, { type: "ready", jobId: "j1", urls: { desktop: "a", mobile: "b" }, at: 1000 });
    expect(state.current?.status).toBe("ready");
    expect(state.lastFinishedAt).toBe(1000);
    expect(admitSceneJob(state, 1000 + SCENE_COOLDOWN_MS - 1).ok).toBe(false);
    expect(admitSceneJob(state, 1000 + SCENE_COOLDOWN_MS).ok).toBe(true);
  });

  it("每会话最多 5 次", () => {
    let state = initialSceneJobState();
    for (let i = 0; i < SCENE_MAX_JOBS; i++) {
      const at = i * (SCENE_COOLDOWN_MS + 1000);
      state = sceneJobReducer(state, { type: "request", jobId: `j${i}`, at });
      state = sceneJobReducer(state, { type: "written", jobId: `j${i}`, label: "x", at: at + 500 });
      state = sceneJobReducer(state, { type: "ready", jobId: `j${i}`, urls: { desktop: "a", mobile: "b" }, at: at + 1000 });
    }
    expect(state.used).toBe(SCENE_MAX_JOBS);
    expect(admitSceneJob(state, SCENE_MAX_JOBS * (SCENE_COOLDOWN_MS + 1000) + SCENE_COOLDOWN_MS).ok).toBe(false);
  });

  it("rejected 后冷却", () => {
    let state = initialSceneJobState();
    state = sceneJobReducer(state, { type: "request", jobId: "j1", at: 0 });
    state = sceneJobReducer(state, { type: "rejected", jobId: "j1", note: "no", at: 1000 });
    expect(state.current).toBeNull();
    expect(state.lastFinishedAt).toBe(1000);
    expect(admitSceneJob(state, 1000 + SCENE_COOLDOWN_MS - 1).ok).toBe(false);
  });

  it("failed 后冷却", () => {
    let state = initialSceneJobState();
    state = sceneJobReducer(state, { type: "request", jobId: "j1", at: 0 });
    state = sceneJobReducer(state, { type: "failed", jobId: "j1", error: "timeout", at: 1000 });
    expect(state.current?.status).toBe("failed");
    expect(state.lastFinishedAt).toBe(1000);
  });

  it("S6g-A §4.5：failed 只在 writing / generating 下生效（ready 后迟到的超时被忽略）", () => {
    let state = initialSceneJobState();
    state = sceneJobReducer(state, { type: "request", jobId: "j1", at: 0 });
    state = sceneJobReducer(state, { type: "written", jobId: "j1", label: "海边", at: 500 });
    state = sceneJobReducer(state, { type: "ready", jobId: "j1", urls: { desktop: "a", mobile: "b" }, at: 1000 });

    // ready 之后迟到的 failed（超时）不改变状态。
    const lateFailed = sceneJobReducer(state, { type: "failed", jobId: "j1", error: "timeout", at: 2000 });
    expect(lateFailed).toBe(state);
    expect(lateFailed.current?.status).toBe("ready");
    expect(lateFailed.lastFinishedAt).toBe(1000);

    // generating 下仍然生效。
    let generating = initialSceneJobState();
    generating = sceneJobReducer(generating, { type: "request", jobId: "j2", at: 0 });
    generating = sceneJobReducer(generating, { type: "written", jobId: "j2", label: "海边", at: 100 });
    generating = sceneJobReducer(generating, { type: "failed", jobId: "j2", error: "timeout", at: 200 });
    expect(generating.current?.status).toBe("failed");
  });
});
