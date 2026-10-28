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
import { accentSchema, actionSchema, cameraSchema, emotionSchema, fxSchema, mediaSchema, storyNodeSchema, type Accent, type Action, type Camera, type Emotion, type Fx, type Media, type StoryNode } from "@mira/protocol";

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

/** D43：只剩 Live2D 一种渲染器。 */
const rendererSchema = z.object({ kind: z.literal("live2d"), model: z.string().min(1) });

const voiceSchema = z.object({
  /** 真实模式下 TTS 音色所在的 .env 变量名（如 `FISH_VOICE_ID` / `FISH_VOICE_ID_YUNA`）。 */
  fishVoiceIdEnv: z.string().min(1),
});

const mediaSlotsSchema = z.object({
  reveal: mediaSchema,
  ending: mediaSchema,
});

/**
 * S6g-A §2：剧情节点视觉配置（`nodes`）。缺字段即不下发；`null` 与「缺省」语义相同（不下发）。
 * `action` 是该节点进入时强制下发的动作（如 reveal 的 show_item）。
 */
const nodeVisualSchema = z.object({
  camera: cameraSchema.nullish(),
  fx: fxSchema.nullish(),
  media: mediaSchema.nullish(),
  action: actionSchema.nullish(),
});
export type NodeVisual = {
  camera: Camera | null;
  fx: Fx | null;
  media: Media | null;
  action: Action | null;
};

/** 把解析出的节点视觉（字段可能缺省 / undefined）规范成 NodeVisual（缺省 → null）。 */
function normalizeNodeVisuals(
  nodes: Partial<Record<StoryNode, z.infer<typeof nodeVisualSchema>>> | undefined,
): Partial<Record<StoryNode, NodeVisual>> {
  if (!nodes) return {};
  const out: Partial<Record<StoryNode, NodeVisual>> = {};
  for (const [node, visual] of Object.entries(nodes) as Array<[StoryNode, z.infer<typeof nodeVisualSchema>]>) {
    out[node] = {
      camera: visual.camera ?? null,
      fx: visual.fx ?? null,
      media: visual.media ?? null,
      action: visual.action ?? null,
    };
  }
  return out;
}

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
  /** S6g-A §2：剧情节点 → 镜头 / 特效 / 媒体 / 强制动作（键为 storyNodeSchema 的子集）。 */
  nodes: z.record(storyNodeSchema, nodeVisualSchema).optional(),
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
  /** S6l §2：直播间顶部显示的剧情阶段标题。 */
  streamTitle: z.string().min(1),
  guidance: z.string().min(1),
  /** S6l §4：沉默时按阶段抛的钩子（ending 为空串表示无 hook）。 */
  hook: z.string(),
  /** S6l §3：观众弹幕引导（ending 为空数组）。 */
  guides: z.array(z.string().min(1)),
  look: z.object({ emotion: emotionSchema, silentAction: actionSchema, accent: accentSchema.nullish() }),
  lines: nodeLinesSchema,
});

const nudgeBeatSchema = z.object({
  say: z.string(),
  emotion: emotionSchema,
  suggest: actionSchema.optional(),
  accent: accentSchema.optional(),
});

/** S6l §5：戳一下 / 送礼物时 Mock 的情景回应。 */
const eventsSchema = z.object({
  poke: z.array(z.string().min(1)).min(1),
  gift: z.array(z.string().min(1)).min(1),
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
  /**
   * freeze-fix3 §2：本会话有「已调度、未就绪」的剧情照片时，nudge 轮追加到 `scene_notes` 的提示。
   * 代码只读该字段，不写死文案。
   */
  photoWaitingNote: z.string().min(1),
  /** freeze-fix3 §3：Mock 在 nudge + 未就绪照片时按次序循环取用的铺垫台词。 */
  photoWaitingLines: z.array(z.string().min(1)).min(1),
  /** S6l §5：戳一下 / 送礼物时 Mock 的情景回应。 */
  events: eventsSchema,
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

export type NodeLook = { emotion: Emotion; silentAction: Action; accent: Accent | null };
export type NodeScript = {
  label: string;
  /** S6l §2：直播间顶部显示的剧情阶段标题。 */
  streamTitle: string;
  guidance: string;
  /** S6l §4：沉默时按阶段抛的钩子（空串表示无 hook）。 */
  hook: string;
  /** S6l §3：观众弹幕引导（可空数组）。 */
  guides: readonly string[];
  look: NodeLook;
  lines: Record<IntentSlot, readonly [string, string]>;
};
export type NudgeBeat = { say: string; emotion: Emotion; suggest?: Action; accent?: Accent };
/** S6l §5：戳一下 / 送礼物时 Mock 的情景回应台词。 */
export type EventLines = { poke: readonly string[]; gift: readonly string[] };

export type Pack = {
  id: string;
  displayName: string;
  renderer: z.infer<typeof rendererSchema>;
  voice: z.infer<typeof voiceSchema>;
  revealIntents: readonly IntentSlot[];
  media: { reveal: Media; ending: Media };
  /** S6g-A §2：剧情节点视觉配置（缺省为空表 → 该节点不下发任何视觉）。 */
  nodeVisuals: Partial<Record<StoryNode, NodeVisual>>;
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
  /** freeze-fix3 §2：截图未就绪时 nudge 轮追加的提示（只读，文案来自 content.json）。 */
  photoWaitingNote: string;
  /** freeze-fix3 §3：Mock 在 nudge + 未就绪照片时按次序循环取用的铺垫台词。 */
  photoWaitingLines: readonly string[];
  /** S6l §5：戳一下 / 送礼物时 Mock 的情景回应台词。 */
  events: EventLines;
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
    // S6l §3/§4：非 ending 节点必须有引导弹幕与钩子。
    if (node !== "ending" && content.nodes[node].guides.length === 0) return `节点 ${node} 缺少 guides`;
    if (node !== "ending" && content.nodes[node].hook === "") return `节点 ${node} 缺少 hook`;
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

  // D47：look.accent 缺省 / undefined → null（NodeLook 契约）。
  // zod 的 record 类型与 NodeScript 的映射不完全重叠（REQUIRED_NODES 已由 crossCheck 保证），故经 unknown 转换。
  const nodes = Object.fromEntries(
    Object.entries(contentParsed.data.nodes).map(([node, script]) => [
      node,
      { ...script, look: { ...script.look, accent: script.look.accent ?? null } },
    ]),
  ) as unknown as Record<StoryNode, NodeScript>;

  return {
    ok: true,
    pack: {
      id: packParsed.data.id,
      displayName: packParsed.data.displayName,
      renderer: packParsed.data.renderer,
      voice: packParsed.data.voice,
      revealIntents: packParsed.data.revealIntents,
      media: packParsed.data.media,
      nodeVisuals: normalizeNodeVisuals(packParsed.data.nodes),
      stage: packParsed.data.stage,
      promptPath: join(input.dir, packParsed.data.prompt),
      promptVersion: input.promptVersion,
      staticText: input.staticText,
      dynamicTemplate: input.dynamicTemplate,
      nodes,
      nudge: contentParsed.data.nudge,
      photoWaitingNote: contentParsed.data.photoWaitingNote,
      photoWaitingLines: contentParsed.data.photoWaitingLines,
      events: contentParsed.data.events,
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
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
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

/** D43：缺省角色 = 目录里第一个角色（只排序确定顺序；现在只有忧奈）。 */
export function defaultCharacterId(packs: ReadonlyMap<string, Pack>): string {
  const first = packs.values().next().value as Pack | undefined;
  if (first === undefined) throw new Error("没有角色包，无法确定缺省角色");
  return first.id;
}
