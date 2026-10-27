import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  charactersRoot,
  contentFileSchema,
  FALLBACK_CATEGORIES,
  INTENT_SLOTS,
  loadPack,
  loadPacks,
  packFileSchema,
  parsePack,
  type Pack,
} from "../src/characters/pack";

const ROOT = charactersRoot();

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function promptParts(dir: string, file: string): { version: string; staticText: string; dynamicTemplate: string } {
  const text = readFileSync(join(dir, file), "utf8");
  const version = /<!--\s*prompt:\s*([^\s·]+)/.exec(text)?.[1] ?? "unknown";
  const staticMatch = /^## STATIC\b.*$/m.exec(text);
  const dynamicMatch = /^## DYNAMIC\b.*$/m.exec(text);
  if (!staticMatch || !dynamicMatch) throw new Error("提示词缺少段落");
  return {
    version,
    staticText: text.slice(staticMatch.index + staticMatch[0].length, dynamicMatch.index).trim(),
    dynamicTemplate: text.slice(dynamicMatch.index + dynamicMatch[0].length).trim(),
  };
}

/** 读一个角色包的原始三件套（用于构造「删字段」的属性测试）。 */
function rawPack(id: string): { dir: string; packJson: unknown; contentJson: unknown; prompt: ReturnType<typeof promptParts> } {
  const dir = join(ROOT, id);
  const packJson = readJson(join(dir, "pack.json")) as { prompt: string };
  return { dir, packJson, contentJson: readJson(join(dir, "content.json")), prompt: promptParts(dir, packJson.prompt) };
}

describe("角色包：忧奈能加载（S6b §1；D43 只剩忧奈）", () => {
  it("characters/ 下只有 yuna，且目录名与 id 一致", () => {
    const packs = loadPacks();
    expect([...packs.keys()].sort()).toEqual(["yuna"]);
    for (const [id, pack] of packs) expect(pack.id).toBe(id);
  });

  it("yuna：Live2D 渲染、FISH_VOICE_ID_YUNA、模型地址与背景", () => {
    const pack = loadPack(join(ROOT, "yuna"));
    expect(pack.displayName).toBe("忧奈");
    expect(pack.renderer).toEqual({ kind: "live2d", model: "/models/yuna/yuna.model3.json" });
    expect(pack.voice.fishVoiceIdEnv).toBe("FISH_VOICE_ID_YUNA");
    expect(pack.promptVersion).toBe("yuna.v1");
    expect(pack.staticText).toContain("忧奈");
    expect(pack.stage.background.landscape).toBe("/characters/yuna/bg-desktop.jpg");
    expect(pack.stage.background.portrait).toBe("/characters/yuna/bg-mobile.jpg");
  });

  it("S6g-A §2：yuna 的 nodes 视觉配置（镜头 / 特效 / 媒体 / 强制动作）", () => {
    const pack = loadPack(join(ROOT, "yuna"));
    expect(pack.nodeVisuals.reveal).toEqual({
      camera: "close_up",
      fx: "stream_dim",
      media: { type: "photo", id: "photo_first_stream" },
      action: "show_item",
    });
    expect(pack.nodeVisuals.ending).toEqual({
      camera: "wide",
      fx: "hearts",
      media: { type: "video", id: "clip_offline" },
      action: null,
    });
    expect(pack.nodeVisuals.arrive).toEqual({ camera: null, fx: null, media: null, action: null });
  });

  it("每个角色：所有节点 × 所有意图都有两句台词，fallback 五类齐全", () => {
    for (const pack of loadPacks().values()) {
      for (const node of ["arrive", "probe", "reveal", "ending"] as const) {
        for (const slot of INTENT_SLOTS) {
          const pair = pack.nodes[node].lines[slot];
          expect(pair, `${pack.id} ${node} ${slot}`).toHaveLength(2);
          expect(pair[0].length).toBeGreaterThan(0);
          expect(pair[1].length).toBeGreaterThan(0);
        }
      }
      for (const category of FALLBACK_CATEGORIES) {
        expect(pack.fallback[category].length, `${pack.id} ${category}`).toBeGreaterThan(0);
      }
    }
  });

  it("动作只用通用槽位（drink / glance / phone / show_item）", () => {
    const allowed = new Set(["drink", "glance", "phone", "show_item"]);
    for (const pack of loadPacks().values()) {
      for (const node of ["arrive", "probe", "reveal", "ending"] as const) {
        expect(allowed.has(pack.nodes[node].look.silentAction)).toBe(true);
      }
      for (const beat of pack.nudge) {
        if (beat.suggest !== undefined) expect(allowed.has(beat.suggest)).toBe(true);
      }
    }
  });

  it("imagePrompt 带 {{conversation}} 占位符（S6b §5.5）", () => {
    for (const pack of loadPacks().values()) {
      expect(pack.imagePrompt).toContain("{{conversation}}");
    }
  });
});

describe("parsePack：结构校验", () => {
  it("合法输入返回 Pack", () => {
    const raw = rawPack("yuna");
    const parsed = parsePack({
      dir: raw.dir,
      packJson: raw.packJson,
      contentJson: raw.contentJson,
      promptVersion: raw.prompt.version,
      staticText: raw.prompt.staticText,
      dynamicTemplate: raw.prompt.dynamicTemplate,
    });
    expect(parsed.ok).toBe(true);
  });

  it("pack.json 缺 id → 拒绝", () => {
    const raw = rawPack("yuna");
    const packJson = { ...(raw.packJson as Record<string, unknown>) };
    delete packJson.id;
    const parsed = parsePack({
      dir: raw.dir,
      packJson,
      contentJson: raw.contentJson,
      promptVersion: "x",
      staticText: "s",
      dynamicTemplate: "d",
    });
    expect(parsed.ok).toBe(false);
  });

  it("节点缺少某种意图的台词 → 拒绝（交叉校验）", () => {
    const raw = rawPack("yuna");
    const content = structuredClone(raw.contentJson) as {
      nodes: Record<string, { lines: Record<string, unknown> }>;
    };
    delete content.nodes.arrive?.lines.greeting;
    const parsed = parsePack({
      dir: raw.dir,
      packJson: raw.packJson,
      contentJson: content,
      promptVersion: "x",
      staticText: "s",
      dynamicTemplate: "d",
    });
    expect(parsed.ok).toBe(false);
  });

  it("fallback 缺少一类 → 拒绝", () => {
    const raw = rawPack("yuna");
    const content = structuredClone(raw.contentJson) as { fallback: Record<string, unknown> };
    delete content.fallback.offline;
    const parsed = parsePack({
      dir: raw.dir,
      packJson: raw.packJson,
      contentJson: content,
      promptVersion: "x",
      staticText: "s",
      dynamicTemplate: "d",
    });
    expect(parsed.ok).toBe(false);
  });

  it("动作不是通用槽位 → 拒绝", () => {
    const raw = rawPack("yuna");
    const content = structuredClone(raw.contentJson) as {
      nodes: Record<string, { look: { silentAction: string } }>;
    };
    if (content.nodes.arrive) content.nodes.arrive.look.silentAction = "sip_coffee";
    const parsed = parsePack({
      dir: raw.dir,
      packJson: raw.packJson,
      contentJson: content,
      promptVersion: "x",
      staticText: "s",
      dynamicTemplate: "d",
    });
    expect(parsed.ok).toBe(false);
  });

  it("revealIntents 含非法意图 → 拒绝", () => {
    const raw = rawPack("yuna");
    const packJson = { ...(raw.packJson as Record<string, unknown>), revealIntents: ["ask_waiting"] };
    const parsed = parsePack({
      dir: raw.dir,
      packJson,
      contentJson: raw.contentJson,
      promptVersion: "x",
      staticText: "s",
      dynamicTemplate: "d",
    });
    expect(parsed.ok).toBe(false);
  });

  it("imagePrompt 缺少 {{conversation}} → 拒绝", () => {
    const raw = rawPack("yuna");
    const content = { ...(raw.contentJson as Record<string, unknown>), imagePrompt: "no placeholder" };
    const parsed = parsePack({
      dir: raw.dir,
      packJson: raw.packJson,
      contentJson: content,
      promptVersion: "x",
      staticText: "s",
      dynamicTemplate: "d",
    });
    expect(parsed.ok).toBe(false);
  });

  it("$comment 说明键被忽略，不影响校验", () => {
    const raw = rawPack("yuna");
    expect(JSON.stringify(raw.contentJson)).toContain("$comment");
    const parsed = parsePack({
      dir: raw.dir,
      packJson: raw.packJson,
      contentJson: raw.contentJson,
      promptVersion: raw.prompt.version,
      staticText: raw.prompt.staticText,
      dynamicTemplate: raw.prompt.dynamicTemplate,
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("parsePack：属性测试（fast-check）", () => {
  /** 必需字段清单（pack.json 与 content.json 的顶层 + 关键嵌套）。 */
  const PACK_KEYS = ["id", "displayName", "renderer", "voice", "prompt", "content", "revealIntents", "media", "stage"];
  const CONTENT_KEYS = ["displayName", "intents", "nodes", "nudge", "fallback", "imagePrompt"];

  it("任意删掉一个必需字段都会被拒绝（pack.json）", () => {
    const raw = rawPack("yuna");
    fc.assert(
      fc.property(fc.constantFrom(...PACK_KEYS), (key) => {
        const packJson = structuredClone(raw.packJson) as Record<string, unknown>;
        delete packJson[key];
        const parsed = parsePack({
          dir: raw.dir,
          packJson,
          contentJson: raw.contentJson,
          promptVersion: "x",
          staticText: "s",
          dynamicTemplate: "d",
        });
        return parsed.ok === false;
      }),
      { numRuns: PACK_KEYS.length * 3 },
    );
  });

  it("任意删掉一个必需字段都会被拒绝（content.json）", () => {
    const raw = rawPack("yuna");
    fc.assert(
      fc.property(fc.constantFrom(...CONTENT_KEYS), (key) => {
        const content = structuredClone(raw.contentJson) as Record<string, unknown>;
        delete content[key];
        const parsed = parsePack({
          dir: raw.dir,
          packJson: raw.packJson,
          contentJson: content,
          promptVersion: "x",
          staticText: "s",
          dynamicTemplate: "d",
        });
        return parsed.ok === false;
      }),
      { numRuns: CONTENT_KEYS.length * 3 },
    );
  });

  it("任意删掉一个 fallback 类别都会被拒绝", () => {
    const raw = rawPack("yuna");
    fc.assert(
      fc.property(fc.constantFrom(...FALLBACK_CATEGORIES), (category) => {
        const content = structuredClone(raw.contentJson) as { fallback: Record<string, unknown> };
        delete content.fallback[category];
        const parsed = parsePack({
          dir: raw.dir,
          packJson: raw.packJson,
          contentJson: content,
          promptVersion: "x",
          staticText: "s",
          dynamicTemplate: "d",
        });
        return parsed.ok === false;
      }),
      { numRuns: FALLBACK_CATEGORIES.length * 3 },
    );
  });

  it("任意删掉一个节点的某句台词都会被拒绝", () => {
    const raw = rawPack("yuna");
    const nodes = ["arrive", "probe", "reveal", "ending"] as const;
    fc.assert(
      fc.property(fc.constantFrom(...nodes), fc.constantFrom(...INTENT_SLOTS), (node, slot) => {
        const content = structuredClone(raw.contentJson) as {
          nodes: Record<string, { lines: Record<string, [string, string]> }>;
        };
        const lines = content.nodes[node]?.lines;
        if (!lines) return true;
        const pair = lines[slot];
        if (!pair) return true;
        lines[slot] = [pair[0]] as unknown as [string, string];
        const parsed = parsePack({
          dir: raw.dir,
          packJson: raw.packJson,
          contentJson: content,
          promptVersion: "x",
          staticText: "s",
          dynamicTemplate: "d",
        });
        return parsed.ok === false;
      }),
      { numRuns: 40 },
    );
  });

  it("导出的 schema 能独立校验两个真实角色包", () => {
    // 角色包用 `$comment` 写文档；parsePack 会先剥掉它们，这里同样处理。
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip);
      if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
          if (key === "$comment") continue;
          out[key] = strip(inner);
        }
        return out;
      }
      return value;
    };
    for (const id of ["yuna"] as const) {
      const raw = rawPack(id);
      expect(packFileSchema.safeParse(strip(raw.packJson)).success).toBe(true);
      expect(contentFileSchema.safeParse(strip(raw.contentJson)).success).toBe(true);
    }
  });
});

describe("角色包：内容原样搬运（铁律 6）", () => {
  it("yuna 的兜底台词与说明一致", () => {
    const pack: Pack = loadPack(join(ROOT, "yuna"));
    expect(pack.fallback).toEqual({
      stt_empty: "你那边声音糊了，没听清，再说一次？",
      stt_failed: "啊，卡了卡了，网络又抽风了……你刚说啥？",
      llm_timeout: "……抱歉，刚刚发呆了。你说到哪了？",
      turn_failed: "直播间好像卡住了，等我一下……好了，你继续。",
      offline: "诶？画面卡住了……还在吗？",
      scene_failed: "诶，背景卡住了，没换成……先凑合一下吧。",
      scene_rejected: "这个不行哦，换一个别的吧。",
      scene_busy: "等等，上一个还没换完呢。",
    });
  });

  it("yuna 的节点 label 与说明一致", () => {
    const pack = loadPack(join(ROOT, "yuna"));
    expect(pack.nodes.arrive.label).toBe("下播之后");
    expect(pack.nodes.probe.label).toBe("防备");
    expect(pack.nodes.reveal.label).toBe("老截图");
    expect(pack.nodes.ending.label).toBe("决定");
  });

  it("yuna 的剧本台词原样保留（抽查各节点）", () => {
    const pack = loadPack(join(ROOT, "yuna"));
    expect(pack.nodes.arrive.lines.greeting).toEqual(["……诶？还有人？", "我以为大家都走了，推流忘关了。"]);
    expect(pack.nodes.probe.lines.ask_core).toEqual(["哈，我能有什么事。", "就是在想……算了，不说了。"]);
    expect(pack.nodes.reveal.lines.ask_item).toEqual(["这是我第一次开播。", "三个观众，我紧张到一直在喝水。"]);
    expect(pack.nodes.ending.lines.other).toEqual(["晚安，最后一位观众。", "这次真的下播啦。"]);
  });

  it("yuna 的主动开口台词原样保留", () => {
    const pack = loadPack(join(ROOT, "yuna"));
    expect(pack.nudge).toEqual([
      { say: "", emotion: "calm", suggest: "drink" },
      { say: "……还在吗？弹幕好安静。", emotion: "calm" },
    ]);
  });
});
