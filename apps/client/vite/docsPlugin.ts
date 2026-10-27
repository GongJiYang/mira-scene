/**
 * 开发文档虚拟模块插件（S6d-fix1）。
 *
 * 提供 `virtual:mira-docs`：在 Node 侧扫描仓库根下的候选 Markdown，
 * 用 `src/docs/core.ts` 的 `isIncluded()`（唯一白名单）过滤后导出
 * `DOC_LOADERS`。每篇文档一个动态 import 的子虚拟模块
 * （`virtual:mira-docs/<encoded path>`），保持按需加载、每篇一个 chunk。
 *
 * 安全约束：读取前再次校验 `isIncluded(path)`，并拒绝任何 `..`、
 * 反斜杠或绝对路径（防路径穿越），解码结果必须落在仓库根之内。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { isIncluded } from "../src/docs/core";

const VIRTUAL_ID = "virtual:mira-docs";
const RESOLVED_VIRTUAL_ID = "\0virtual:mira-docs";
const SUB_PREFIX = "virtual:mira-docs/";
const RESOLVED_SUB_PREFIX = "\0virtual:mira-docs/";

/** 仓库根目录（本文件在 `apps/client/vite/` 下，上三级到仓库根）。 */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// ── 纯函数部分（可单测，不碰 fs / Vite）────────────────────────────

/** 把仓库相对路径编码进子虚拟模块 id（保留路径分隔，防止撞名）。 */
export function encodeDocPath(repoPath: string): string {
  return repoPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * 把子虚拟模块 id 解码回仓库相对路径。
 * 拒绝任何 `..`、反斜杠、绝对路径、空段与隐藏段 —— 这些都不合法，返回 null。
 */
export function decodeDocPath(encoded: string): string | null {
  if (encoded.length === 0) return null;
  const segments: string[] = [];
  for (const rawSegment of encoded.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (segment.length === 0) return null;
    if (segment === "." || segment === "..") return null;
    if (segment.includes("\\") || segment.includes("\0")) return null;
    if (segment.startsWith(".")) return null;
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (path.posix.isAbsolute(joined) || path.win32.isAbsolute(joined)) return null;
  if (/^[A-Za-z]:/.test(joined)) return null;
  return joined;
}

/**
 * 把解码出的仓库相对路径解析成绝对路径，并确认落在仓库根之内。
 * 任何逃逸（`..`、符号链接外的绝对结果）都返回 null。
 */
export function resolveWithinRoot(root: string, repoPath: string): string | null {
  const absolute = path.resolve(root, repoPath);
  const relative = path.relative(root, absolute);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return absolute;
}

/** 候选扫描只下钻这几个目录（白名单覆盖的目录），不遍历整个仓库。 */
const SCAN_DIRS = ["docs/architecture", "docs/tasks", "characters"] as const;

/** 白名单覆盖的根目录文件（如果存在）。 */
const ROOT_FILES = ["README.md", "AI_USAGE.md", "docs/ai-usage-log.md"] as const;

/**
 * 纯函数：候选路径 → 过滤 → 排序。
 * 白名单只保留在 `core.ts` 的 `isIncluded()` 一处，这里直接调用。
 */
export function filterCandidates(candidates: readonly string[]): string[] {
  return candidates.filter(isIncluded).sort((a, b) => a.localeCompare(b));
}

// ── Node 侧扫描（插件运行时使用，不可单测的部分尽量薄）─────────────

async function walk(dir: string, prefix: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在时当作没有候选（例如 characters/ 可能被清理）。
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // 隐藏文件/目录永不收录
    const repoPath = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name), repoPath, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(repoPath);
    }
  }
}

/** 扫描仓库根下的白名单候选文件（只下钻白名单覆盖的目录）。 */
export async function scanCandidates(root: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const dir of SCAN_DIRS) {
    await walk(path.join(root, dir), dir, candidates);
  }
  for (const file of ROOT_FILES) {
    try {
      if ((await stat(path.join(root, file))).isFile()) candidates.push(file);
    } catch {
      // 不存在就跳过（例如 AI_USAGE.md 可选）。
    }
  }
  return filterCandidates(candidates);
}

// ── Vite 插件本体 ─────────────────────────────────────────────────

export function docsPlugin(): Plugin {
  /** 当前收录的文档（repo 相对路径，已排序）。 */
  let docPaths: string[] = [];
  /** repo 相对路径 → 子虚拟模块 id（未加 \0）。 */
  const subIds = new Map<string, string>();
  let serverInvalidator: ((encoded: string) => void) | null = null;

  function subIdFor(repoPath: string): string {
    let id = subIds.get(repoPath);
    if (id === undefined) {
      id = `${SUB_PREFIX}${encodeDocPath(repoPath)}`;
      subIds.set(repoPath, id);
    }
    return id;
  }

  async function rescan(): Promise<void> {
    docPaths = await scanCandidates(REPO_ROOT);
    for (const repoPath of docPaths) subIdFor(repoPath);
  }

  return {
    name: "mira-docs",

    async buildStart() {
      // 扫描出的文档必须在生成 import 语句之前就绪（见 load），不能只在 buildStart 做。
      await rescan();
      // 让每个收录文件都参与 watch：改动会触发 rebuild / handleHotUpdate。
      for (const repoPath of docPaths) {
        const absolute = resolveWithinRoot(REPO_ROOT, repoPath);
        if (absolute !== null) this.addWatchFile(absolute);
      }
    },

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
      if (id.startsWith(SUB_PREFIX)) return `\0${id}`;
      return null;
    },

    async load(id) {
      if (id === RESOLVED_VIRTUAL_ID) {
        if (docPaths.length === 0) await rescan();
        const lines = docPaths.map((repoPath) => {
          const importPath = JSON.stringify(subIdFor(repoPath));
          const docPath = JSON.stringify(repoPath);
          return `{ path: ${docPath}, load: () => import(${importPath}).then((m) => m.default) }`;
        });
        return `export const DOC_LOADERS = [${lines.join(",")}];`;
      }
      if (id.startsWith(RESOLVED_SUB_PREFIX)) {
        const repoPath = decodeDocPath(id.slice(RESOLVED_SUB_PREFIX.length));
        // 读取前再校验一次：白名单 + 防路径穿越，双重校验。
        if (repoPath === null || !isIncluded(repoPath)) return null;
        const absolute = resolveWithinRoot(REPO_ROOT, repoPath);
        if (absolute === null) return null;
        const content = await readFile(absolute, "utf8");
        return `export default ${JSON.stringify(content)};`;
      }
      return null;
    },

    configureServer(server) {
      serverInvalidator = (encoded: string) => {
        const moduleId = `${RESOLVED_SUB_PREFIX}${encoded}`;
        const mod = server.moduleGraph.getModuleById(moduleId);
        if (mod) server.moduleGraph.invalidateModule(mod);
      };
    },

    handleHotUpdate({ file }) {
      const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (!isIncluded(relative)) return;
      const encoded = encodeDocPath(relative);
      if (serverInvalidator !== null) serverInvalidator(encoded);
    },
  };
}
