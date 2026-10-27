/**
 * 角色包（S6b §1）：`characters/<id>/{pack.json, content.json, prompt.v1.md}`。
 *
 * `parsePack` 是纯函数：zod 结构校验 + 交叉校验（每节点 × 每意图都有两句台词；
 * fallback 五类齐全；动作只用通用槽位；revealIntents 是合法意图）。失败返回 `Error`。
 * 服务端启动时用 `loadPacks` 加载全部角色包，任何一个不合法都直接抛错（启动即失败）。
 *
 * 文字内容（台词、提示词）一律来自 content.json / prompt.v1.md，本模块不改写任何文字（铁律 6）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { actionSchema, emotionSchema, mediaSchema, storyNodeSchema, type Action, type Emotion, type Media, type StoryNode } from "@mira/protocol";

/* ------------------------------------------------------------------------------------------------
 * 通用意图槽位（S6b §1）。意图不进 protocol：它是「Mock 剧本 + 提示词」层的概念。
 * ---------------------------------------------------------------------------------------------- */
export const INTENT_SLOTS = ["ask_core", "ask_item", "ask_job", "comfort", "greeting", "other"] as const;
export type IntentSlot = (typeof INTENT_SLOTS)[number];
export const intentSlotSchema = z.enum(INTENT_SLOTS);

/** 五类兜底（S6b §2）+ 换背景三类（S6c §5）。 */
export const FALLBACK_CATEGORIES = [
  "stt_empty",
  "stt_failed",
  "llm_timeout",
  "turn_failed",
  "offline",
  "scene_failed",
  "scene_rejected",
  "scene_busy",
] as const;
export type FallbackCategory = (typeof FALLBACK_CATEGORIES)[number];

/* ------------------------------------------------------------------------------------------------
 * pack.json schema
 * ---------------------------------------------------------------------------------------------- */

const rendererSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("layered") }),
  z.object({ kind: z.literal("live2d"), model: z.string().min(1) }),
]);

const voiceSchema = z.object({
  /** 真实模式下 TTS 音色所在的 .env 变量名（如 `FISH_VOICE_ID` / `FISH_VOICE_ID_YUNA`）。 */
  fishVoiceIdEnv: z.string().min(1),
});

const mediaSlotsSchema = z.object({
  reveal: mediaSchema,
  ending: mediaSchema,
});

const stageSchema = z.object({
  background: z.object({ portrait: z.string().min(1), landscape: z.string().min(1) }),
  backgroundClips: z.object({ portrait: z.string().min(1), landscape: z.string().min(1) }),
  tint: z.string().min(1),
});

/**
 * S6c §3：构图锁（英文常量，由代码原样追加到生图提示词，LLM 无法修改）。
 * 写在 pack.json 的 `sceneLock` 字段；缺省按角色给默认（rin 的小桌 / yuna 的软垫）。
 */
const sceneLockSchema = z.string().min(1);

export const packFileSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  renderer: rendererSchema,
  voice: voiceSchema,
  /** 相对角色包目录的提示词文件名，例如 `prompt.v1.md`。 */
  prompt: z.string().min(1),
  /** 相对角色包目录的内容文件名，例如 `content.json`。 */
  content: z.string().min(1),
  /** probe → reveal 的触发意图（S6b §1）。 */
  revealIntents: z.array(intentSlotSchema).min(1),
  media: mediaSlotsSchema,
  stage: stageSchema,
  /** S6c §3：构图锁（英文常量）。 */
  sceneLock: sceneLockSchema,
});

/* ------------------------------------------------------------------------------------------------
 * content.json schema
 * ---------------------------------------------------------------------------------------------- */

const nodeLinesSchema = z.record(intentSlotSchema, z.tuple([z.string(), z.string()]));

const nodeSchema = z.object({
  label: z.string().min(1),
  guidance: z.string().min(1),
  look: z.object({ emotion: emotionSchema, silentAction: actionSchema }),
  lines: nodeLinesSchema,
});

const nudgeBeatSchema = z.object({
  say: z.string(),
  emotion: emotionSchema,
  suggest: actionSchema.optional(),
});

export const contentFileSchema = z.object({
  displayName: z.string().min(1),
  /**
   * 意图槽位 → 该角色的关键词正则片段（按顺序匹配）。
   * `other` 是兜底槽位，不需要关键词，因此允许省略。
   */
  intents: z.record(intentSlotSchema, z.string()),
  nodes: z.record(storyNodeSchema, nodeSchema),
  nudge: z.array(nudgeBeatSchema).min(1),
  /** 五类兜底台词（键为 FALLBACK_CATEGORIES；完整性由 crossCheck 保证）。 */
  fallback: z.record(z.string(), z.string().min(1)),
  /** 生图提示词模板（含 `{{conversation}}`，S6b §5.5）。 */
  imagePrompt: z.string().min(1),
  /**
   * S6c §1：换背景触发关键词（正则片段）。
   * 命中与否都不影响这一轮的正常对话：角色照常回话；命中时额外启动场景任务。
   */
  sceneTriggers: z.string().min(1),
});

/* ------------------------------------------------------------------------------------------------
 * 组合后的角色包
 * ---------------------------------------------------------------------------------------------- */

export type NodeLook = { emotion: Emotion; silentAction: Action };
export type NodeScript = { label: string; guidance: string; look: NodeLook; lines: Record<IntentSlot, readonly [string, string]> };
export type NudgeBeat = { say: string; emotion: Emotion; suggest?: Action };

export type Pack = {
  id: string;
  displayName: string;
  renderer: z.infer<typeof rendererSchema>;
  voice: z.infer<typeof voiceSchema>;
  revealIntents: readonly IntentSlot[];
  media: { reveal: Media; ending: Media };
  stage: z.infer<typeof stageSchema>;
  /** 提示词静态/动态模板（由 loader 解析）。 */
  promptPath: string;
  /** 已解析的提示词模板。 */
  promptVersion: string;
  staticText: string;
  dynamicTemplate: string;
  /** 剧情节点脚本（label / guidance / look / lines）。 */
  nodes: Record<StoryNode, NodeScript>;
  nudge: readonly NudgeBeat[];
  fallback: Record<FallbackCategory, string>;
  /** 意图槽位 → 正则片段（编译后的 RegExp）。 */
  intentPatterns: ReadonlyArray<readonly [IntentSlot, RegExp]>;
  imagePrompt: string;
  /** S6c §3：构图锁（英文常量，由代码原样追加到生图提示词）。 */
  sceneLock: string;
  /** S6c §1：换背景触发关键词（编译后的 RegExp）。 */
  sceneTriggerPattern: RegExp;
  /** 角色包目录绝对路径（便于记录来源）。 */
  dir: string;
};

/** 交叉校验：所有节点 × 所有意图都要有台词（schema 用 record 已强制，这里补需要的节点齐全）。 */
const REQUIRED_NODES: readonly StoryNode[] = ["arrive", "probe", "reveal", "ending"];

function crossCheck(content: z.infer<typeof contentFileSchema>, revealIntents: readonly IntentSlot[]): string | null {
  for (const node of REQUIRED_NODES) {
    if (!content.nodes[node]) return `缺少剧情节点 ${node}`;
    const lines = content.nodes[node].lines;
    for (const slot of INTENT_SLOTS) {
      const pair = lines[slot];
      if (!pair || pair.length !== 2) return `节点 ${node} 的意图 ${slot} 不是两句台词`;
    }
  }
  for (const category of FALLBACK_CATEGORIES) {
    if (content.fallback[category] === undefined) return `fallback 缺少类别 ${category}`;
  }
  for (const slot of revealIntents) {
    if (!INTENT_SLOTS.includes(slot)) return `revealIntents 含非法意图 ${slot}`;
  }
  if (!content.imagePrompt.includes("{{conversation}}")) return "imagePrompt 缺少 {{conversation}} 占位符";
  // S6c §1：sceneTriggers 必须是合法正则。
  try {
    new RegExp(content.sceneTriggers);
  } catch {
    return `sceneTriggers 不是合法正则：${content.sceneTriggers}`;
  }
  return null;
}

export type ParsePackResult = { ok: true; pack: Pack } | { ok: false; error: Error };

/**
 * 去掉 JSON 里的 `$comment` 说明键（角色包用它们写文档）。
 * 只处理对象层，不改任何文字内容。
 */
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$comment") continue;
      out[key] = stripComments(inner);
    }
    return out;
  }
  return value;
}

/**
 * 纯函数：pack.json / content.json / 提示词文本 → Pack。
 * 结构或交叉校验失败时返回 `Error`，不抛错（调用方决定如何处理）。
 */
export function parsePack(input: {
  dir: string;
  packJson: unknown;
  contentJson: unknown;
  promptVersion: string;
  staticText: string;
  dynamicTemplate: string;
}): ParsePackResult {
  const packParsed = packFileSchema.safeParse(stripComments(input.packJson));
  if (!packParsed.success) {
    return { ok: false, error: new Error(`pack.json 非法：${packParsed.error.issues[0]?.path.join(".") ?? "?"} ${packParsed.error.issues[0]?.message ?? ""}`.trim()) };
  }
  const contentParsed = contentFileSchema.safeParse(stripComments(input.contentJson));
  if (!contentParsed.success) {
    return { ok: false, error: new Error(`content.json 非法：${contentParsed.error.issues[0]?.path.join(".") ?? "?"} ${contentParsed.error.issues[0]?.message ?? ""}`.trim()) };
  }
  const cross = crossCheck(contentParsed.data, packParsed.data.revealIntents);
  if (cross !== null) return { ok: false, error: new Error(`角色包交叉校验失败：${cross}`) };

  const intentPatterns: Array<readonly [IntentSlot, RegExp]> = [];
  for (const slot of INTENT_SLOTS) {
    const source = contentParsed.data.intents[slot];
    // `other` 是兜底槽位：没有关键词时跳过（classifyIntent 不命中任何规则即返回 other）。
    if (source === undefined) {
      if (slot === "other") continue;
      return { ok: false, error: new Error(`intents 缺少槽位 ${slot}`) };
    }
    try {
      intentPatterns.push([slot, new RegExp(source)]);
    } catch {
      return { ok: false, error: new Error(`槽位 ${slot} 的关键词不是合法正则：${source}`) };
    }
  }

  const nodes = contentParsed.data.nodes as Record<StoryNode, NodeScript>;

  return {
    ok: true,
    pack: {
      id: packParsed.data.id,
      displayName: packParsed.data.displayName,
      renderer: packParsed.data.renderer,
      voice: packParsed.data.voice,
      revealIntents: packParsed.data.revealIntents,
      media: packParsed.data.media,
      stage: packParsed.data.stage,
      promptPath: join(input.dir, packParsed.data.prompt),
      promptVersion: input.promptVersion,
      staticText: input.staticText,
      dynamicTemplate: input.dynamicTemplate,
      nodes,
      nudge: contentParsed.data.nudge,
      fallback: contentParsed.data.fallback as Record<FallbackCategory, string>,
      intentPatterns,
      imagePrompt: contentParsed.data.imagePrompt,
      sceneLock: packParsed.data.sceneLock,
      sceneTriggerPattern: new RegExp(contentParsed.data.sceneTriggers),
      dir: input.dir,
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * 磁盘加载（I/O 层）
 * ---------------------------------------------------------------------------------------------- */

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("找不到仓库根目录（pnpm-workspace.yaml）");
    dir = parent;
  }
}

/** 仓库根下的 `characters/` 目录。 */
export function charactersRoot(): string {
  return join(findRepoRoot(dirname(fileURLToPath(import.meta.url))), "characters");
}

/** 仓库根下的客户端静态目录 `apps/client/public/`（背景等舞台资源按 URL 从这里解析）。 */
export function clientPublicRoot(): string {
  return join(findRepoRoot(dirname(fileURLToPath(import.meta.url))), "apps", "client", "public");
}

/**
 * S6c §4：把舞台背景的公开 URL（如 `/characters/yuna/bg-desktop.jpg`、`/stage/assets/raw/b1_bg_main_h.png`）
 * 解析成 `apps/client/public/` 下的本地文件路径，作为参考图生图的输入。
 */
export function resolveClientAssetPath(publicUrl: string): string {
  return join(clientPublicRoot(), publicUrl.replace(/^\/+/, ""));
}

/** 解析提示词文件（与 prompts/loader.ts 同规则：取版本 + STATIC/DYNAMIC 段落）。 */
function readPromptFile(path: string): { version: string; staticText: string; dynamicTemplate: string } {
  const text = readFileSync(path, "utf8");
  const version = /<!--\s*prompt:\s*([^\s·]+)/.exec(text)?.[1] ?? "unknown";
  const staticMatch = /^## STATIC\b.*$/m.exec(text);
  const dynamicMatch = /^## DYNAMIC\b.*$/m.exec(text);
  if (!staticMatch || !dynamicMatch) {
    throw new Error(`提示词文件缺少 ## STATIC / ## DYNAMIC 段落：${path}`);
  }
  const staticStart = staticMatch.index + staticMatch[0].length;
  return {
    version,
    staticText: text.slice(staticStart, dynamicMatch.index).trim(),
    dynamicTemplate: text.slice(dynamicMatch.index + dynamicMatch[0].length).trim(),
  };
}

/** 加载单个角色包目录；任何不合法直接抛错。 */
export function loadPack(dir: string): Pack {
  const packPath = join(dir, "pack.json");
  if (!existsSync(packPath)) throw new Error(`角色包缺少 pack.json：${dir}`);
  const packJson: unknown = JSON.parse(readFileSync(packPath, "utf8"));
  const packFile = packFileSchema.safeParse(stripComments(packJson));
  if (!packFile.success) {
    throw new Error(`角色包 ${dir} 的 pack.json 非法：${packFile.error.issues[0]?.message ?? ""}`);
  }
  const contentPath = join(dir, packFile.data.content);
  if (!existsSync(contentPath)) throw new Error(`角色包 ${dir} 缺少 ${packFile.data.content}`);
  const contentJson: unknown = JSON.parse(readFileSync(contentPath, "utf8"));
  const promptPath = join(dir, packFile.data.prompt);
  if (!existsSync(promptPath)) throw new Error(`角色包 ${dir} 缺少 ${packFile.data.prompt}`);
  const prompt = readPromptFile(promptPath);

  const parsed = parsePack({ dir, packJson, contentJson, promptVersion: prompt.version, staticText: prompt.staticText, dynamicTemplate: prompt.dynamicTemplate });
  if (!parsed.ok) throw new Error(`角色包 ${dir} 不合法：${parsed.error.message}`);
  return parsed.pack;
}

/** 加载 characters 目录下全部角色包（每个子目录的 pack.json）。任何一个不合法 → 抛错（服务端启动失败）。 */
export function loadPacks(root: string = charactersRoot()): Map<string, Pack> {
  if (!existsSync(root)) throw new Error(`找不到角色包目录：${root}`);
  const packs = new Map<string, Pack>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, "pack.json"))) continue;
    const pack = loadPack(dir);
    if (pack.id !== entry.name) throw new Error(`角色包目录名 ${entry.name} 与 id ${pack.id} 不一致`);
    packs.set(pack.id, pack);
  }
  if (packs.size === 0) throw new Error(`角色包目录下没有任何 pack.json：${root}`);
  return packs;
}

/** 缺省角色（S6b §1）。 */
export const DEFAULT_CHARACTER_ID = "rin";
