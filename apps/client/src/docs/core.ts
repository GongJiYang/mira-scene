/**
 * 开发文档窗口的纯函数核心（S6d 关卡 3：函数式核心）。
 *
 * 只做数据处理，不碰 DOM、不发请求。React 组件只负责展示。
 */
import { DOCS_TEXT } from "./docsText";

/** 文档分组：目录树按这个顺序渲染。 */
export type DocGroupId = "architecture" | "reports" | "characters" | "root";

export type DocEntry = {
  /** 仓库相对路径，如 `docs/architecture/decisions.md`。 */
  path: string;
  /** 目录树里显示的名字（不含目录、不含 `.md`）。 */
  title: string;
  group: DocGroupId;
};

export type DocGroup = {
  id: DocGroupId;
  /** 分组标题（用于目录树显示）。 */
  label: string;
  docs: DocEntry[];
};

/**
 * 收录白名单（S6d §1）：只收这些路径；`.log`、`.env*`、隐藏文件永不收录。
 *
 * 白名单用「正则」而不是「前缀匹配」，这样即使有人把 `.env` 改了名，
 * 也不会被收录进来。
 */
const WHITELIST: readonly { group: DocGroupId; pattern: RegExp }[] = [
  { group: "architecture", pattern: /^docs\/architecture\/[^/]+\.md$/ },
  { group: "reports", pattern: /^docs\/ai-usage-log\.md$/ },
  { group: "reports", pattern: /^docs\/tasks\/[^/]+-report\.md$/ },
  { group: "characters", pattern: /^characters\/[^/]+\/(prompt|scene)\.v1\.md$/ },
  { group: "root", pattern: /^(README|AI_USAGE)\.md$/ },
];

const GROUP_LABEL: Record<DocGroupId, string> = DOCS_TEXT.groups;

const GROUP_ORDER: readonly DocGroupId[] = ["architecture", "reports", "characters", "root"];

/** 任何以点开头的路径段（隐藏文件 / 目录）一律排除。 */
function hasHiddenSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.length > 0 && segment.startsWith("."));
}

/** 是否属于收录范围（白名单 + 非隐藏）。 */
export function isIncluded(path: string): boolean {
  if (path.length === 0) return false;
  if (hasHiddenSegment(path)) return false;
  return WHITELIST.some((rule) => rule.pattern.test(path));
}

function groupOf(path: string): DocGroupId {
  const rule = WHITELIST.find((candidate) => candidate.pattern.test(path));
  // 调用点已用 isIncluded 过滤，这里只是取分组；找不到时归入根目录分组。
  return rule?.group ?? "root";
}

/** 从路径得到目录树显示名：去掉目录、去掉 `.md`。 */
export function titleOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/**
 * 纯函数：把路径列表整理成带分组的目录树。
 * 只收录白名单内的路径；同一分组内按标题排序。
 */
export function buildDocTree(paths: readonly string[]): DocGroup[] {
  const included: DocEntry[] = paths
    .filter(isIncluded)
    .map((path) => ({ path, title: titleOf(path), group: groupOf(path) }));

  return GROUP_ORDER.map((id) => ({
    id,
    label: GROUP_LABEL[id],
    docs: included
      .filter((entry) => entry.group === id)
      .sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN")),
  })).filter((group) => group.docs.length > 0);
}

export type Heading = {
  /** 1–6。 */
  level: number;
  text: string;
  /** 可用于锚点的 slug（同一文档内唯一）。 */
  slug: string;
};

/** 纯函数：把标题文本转成锚点 slug（小写、空白转 `-`、去标点、去首尾 `-`）。 */
export function slugify(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    // 去掉 Markdown 行内标记外的常见标点与空白（保留中日韩文字与字母数字）。
    .replace(/[\s]+/g, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "section";
}

/** 去掉行内 Markdown 标记（`**粗体**`、`` `code` ``、`[文字](url)`），用于标题文本。 */
function stripInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .trim();
}

/**
 * 纯函数：从 Markdown 文本抽取标题（ATX `#` 形式），并生成去重后的 slug。
 * 代码块（``` 围栏）内的 `#` 不算标题。
 */
export function extractHeadings(md: string): Heading[] {
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  let inFence = false;

  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!match) continue;
    const level = match[1]!.length;
    const text = stripInline(match[2]!);
    if (text.length === 0) continue;

    let slug = slugify(text);
    const seen = used.get(slug) ?? 0;
    used.set(slug, seen + 1);
    if (seen > 0) slug = `${slug}-${seen}`;
    headings.push({ level, text, slug });
  }

  return headings;
}

export type SearchHit = {
  path: string;
  title: string;
  /** 命中数（同一文档里出现几次）。 */
  count: number;
  /** 命中处的片段（最多 `maxSnippets` 条）。 */
  snippets: string[];
};

type DocForIndex = { path: string; title: string; content: string };

function normalize(text: string): string {
  return text.toLowerCase();
}

/** 取 `index` 所在行的片段，去掉行首 Markdown 标记，截断到合理长度。 */
function snippetAround(line: string): string {
  const cleaned = line.replace(/^\s*[>#\-*\d.]+\s*/, "").trim();
  const limit = 120;
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

/**
 * 纯函数：在文档索引里做大小写不敏感的子串搜索。
 * 返回命中文档（按命中数降序）+ 每篇最多 `maxSnippets` 条上下文片段。
 * 空查询返回空数组。
 */
export function searchDocs(index: readonly DocForIndex[], query: string, maxSnippets = 3): SearchHit[] {
  const needle = normalize(query.trim());
  if (needle.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const doc of index) {
    const haystack = normalize(doc.content);
    let from = 0;
    let count = 0;
    const snippets: string[] = [];
    let index0 = haystack.indexOf(needle, from);
    while (index0 !== -1) {
      count += 1;
      if (snippets.length < maxSnippets) {
        const lineStart = doc.content.lastIndexOf("\n", index0 - 1) + 1;
        const lineEndRaw = doc.content.indexOf("\n", index0);
        const lineEnd = lineEndRaw === -1 ? doc.content.length : lineEndRaw;
        snippets.push(snippetAround(doc.content.slice(lineStart, lineEnd)));
      }
      from = index0 + needle.length;
      index0 = haystack.indexOf(needle, from);
    }
    if (count > 0) hits.push({ path: doc.path, title: doc.title, count, snippets });
  }

  return hits.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, "zh-Hans-CN"));
}
