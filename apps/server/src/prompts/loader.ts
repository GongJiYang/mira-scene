/**
 * 提示词加载（D18、第 9 轮）：读取 `characters/yuna/prompt.v1.md`，切成静态前缀与动态后缀。
 *
 * - `## STATIC` 部分作为 system 消息，逐字不变（命中前缀缓存）。
 * - `## DYNAMIC` 部分是模板，由 `renderPrompt` 填充后作为最后一条 user 消息。
 * - `version` 取自文件头注释（例如 `yuna.v1`），每一轮写入日志。
 *
 * D43：夏凛删除后 `prompts/rin.v1.md` 一并删除；默认提示词改用忧奈角色包里的那份。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 相对仓库根目录的提示词文件路径（忧奈角色包内的那份）。 */
export const PROMPT_FILE = "characters/yuna/prompt.v1.md";

export type PromptTemplate = {
  /** 例如 `yuna.v1`。 */
  version: string;
  /** `## STATIC` 正文（逐字不变）。 */
  staticText: string;
  /** `## DYNAMIC` 模板（含 `{{...}}` 占位符）。 */
  dynamicTemplate: string;
  /** 实际读取的文件路径，便于排查。 */
  source: string;
};

const STATIC_HEADER = "## STATIC";
const DYNAMIC_HEADER = "## DYNAMIC";

/** 从当前文件位置向上找仓库根目录（pnpm-workspace.yaml）。 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("找不到仓库根目录（pnpm-workspace.yaml）");
    dir = parent;
  }
}

export function parsePromptFile(text: string, source: string): PromptTemplate {
  const version = /<!--\s*prompt:\s*([^\s·]+)/.exec(text)?.[1] ?? "unknown";
  // 行首锚定，避免文件头注释里出现的同名字样被误匹配。
  const staticMatch = new RegExp(`^${STATIC_HEADER}\\b.*$`, "m").exec(text);
  const dynamicMatch = new RegExp(`^${DYNAMIC_HEADER}\\b.*$`, "m").exec(text);
  if (!staticMatch || !dynamicMatch) {
    throw new Error(`提示词文件缺少 ${STATIC_HEADER} / ${DYNAMIC_HEADER} 段落：${source}`);
  }
  const staticStart = staticMatch.index + staticMatch[0].length;
  return {
    version,
    staticText: text.slice(staticStart, dynamicMatch.index).trim(),
    dynamicTemplate: text.slice(dynamicMatch.index + dynamicMatch[0].length).trim(),
    source,
  };
}

export function loadPromptTemplate(path?: string): PromptTemplate {
  const file = path ?? join(findRepoRoot(dirname(fileURLToPath(import.meta.url))), PROMPT_FILE);
  return parsePromptFile(readFileSync(file, "utf8"), file);
}
