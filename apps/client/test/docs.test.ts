import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildDocTree, extractHeadings, isIncluded, searchDocs, slugify, titleOf } from "../src/docs/core";

describe("isIncluded 白名单", () => {
  it("收录白名单内的路径", () => {
    expect(isIncluded("docs/architecture/decisions.md")).toBe(true);
    expect(isIncluded("docs/ai-usage-log.md")).toBe(true);
    expect(isIncluded("docs/tasks/s6d-docs-report.md")).toBe(true);
    expect(isIncluded("characters/yuna/prompt.v1.md")).toBe(true);
    expect(isIncluded("characters/yuna/scene.v1.md")).toBe(true);
    expect(isIncluded("README.md")).toBe(true);
    expect(isIncluded("AI_USAGE.md")).toBe(true);
  });

  it("不收录任务说明、日志、隐藏文件、.env", () => {
    expect(isIncluded("docs/tasks/s6d-docs.md")).toBe(false);
    expect(isIncluded("docs/tasks/.s6d-cmd.log")).toBe(false);
    expect(isIncluded("docs/.env")).toBe(false);
    expect(isIncluded(".env.example")).toBe(false);
    expect(isIncluded("docs/architecture/notes.txt")).toBe(false);
    expect(isIncluded("characters/yuna/content.json")).toBe(false);
    expect(isIncluded("")).toBe(false);
  });

  it("属性：白名单永远不收录 .log / .env / 隐藏文件（fast-check）", () => {
    const segment = fc.string({ minLength: 1, maxLength: 6 }).filter((s) => !s.includes("/"));
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), (segments) => {
        const logPath = [...segments.slice(0, -1), `${segments[segments.length - 1]}.log`].join("/");
        const envPath = [...segments.slice(0, -1), ".env"].join("/");
        const hiddenPath = [...segments.slice(0, -1), `.${segments[segments.length - 1]}`].join("/");
        expect(isIncluded(logPath)).toBe(false);
        expect(isIncluded(envPath)).toBe(false);
        expect(isIncluded(hiddenPath)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe("titleOf", () => {
  it("去掉目录与 .md 后缀", () => {
    expect(titleOf("docs/architecture/decisions.md")).toBe("decisions");
    expect(titleOf("README.md")).toBe("README");
  });
});

describe("buildDocTree", () => {
  it("按分组归集并过滤白名单", () => {
    const tree = buildDocTree([
      "docs/architecture/decisions.md",
      "docs/architecture/roadmap.md",
      "docs/tasks/.s6d-cmd.log",
      "docs/tasks/s6d-docs.md",
      "docs/tasks/s6d-docs-report.md",
      "characters/yuna/prompt.v1.md",
      "README.md",
    ]);
    const byId = Object.fromEntries(tree.map((group) => [group.id, group.docs.map((doc) => doc.title)]));
    expect(byId.architecture).toEqual(["decisions", "roadmap"]);
    expect(byId.reports).toEqual(["s6d-docs-report"]);
    expect(byId.characters).toEqual(["prompt.v1"]);
    expect(byId.root).toEqual(["README"]);
    // 任务说明与 .log 不在任何分组里。
    const all = tree.flatMap((group) => group.docs.map((doc) => doc.path));
    expect(all).not.toContain("docs/tasks/s6d-docs.md");
    expect(all).not.toContain("docs/tasks/.s6d-cmd.log");
  });

  it("空分组被过滤掉，组内按标题排序", () => {
    const tree = buildDocTree(["README.md", "docs/architecture/zeta.md", "docs/architecture/alpha.md"]);
    expect(tree.map((group) => group.id)).toEqual(["architecture", "root"]);
    expect(tree[0]!.docs.map((doc) => doc.title)).toEqual(["alpha", "zeta"]);
  });

  it("属性：任意路径列表下，输出都不含 .log/.env/隐藏文件（fast-check）", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 6 }), (paths) => {
        const tree = buildDocTree(paths);
        for (const group of tree) {
          for (const doc of group.docs) {
            expect(doc.path.endsWith(".log")).toBe(false);
            expect(doc.path.split("/").every((seg) => !seg.startsWith("."))).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("slugify", () => {
  it("小写、空白转连字符、去标点", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("S6d 任务说明")).toBe("s6d-任务说明");
    expect(slugify("  #1 §2  ")).toBe("1-2");
    expect(slugify("")).toBe("section");
    expect(slugify("!!!")).toBe("section");
  });
});

describe("extractHeadings", () => {
  it("抽取 ATX 标题并生成去重 slug", () => {
    const md = ["# 标题", "", "## 小节", "正文", "### 小节", "#### Deep", "## 小节"].join("\n");
    const headings = extractHeadings(md);
    expect(headings.map((h) => h.text)).toEqual(["标题", "小节", "小节", "Deep", "小节"]);
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3, 4, 2]);
    expect(headings.map((h) => h.slug)).toEqual(["标题", "小节", "小节-1", "deep", "小节-2"]);
  });

  it("代码块里的 # 不算标题", () => {
    const md = ["# 真标题", "```", "# 假的", "```", "```ts", "## 也假的", "```", "## 真的"].join("\n");
    expect(extractHeadings(md).map((h) => h.text)).toEqual(["真标题", "真的"]);
  });

  it("去掉行内标记", () => {
    expect(extractHeadings("## **加粗** 与 `代码`").map((h) => h.text)).toEqual(["加粗 与 代码"]);
  });

  it("属性：任意文本都不抛异常，且 slug 非空（fast-check）", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (md) => {
        const headings = extractHeadings(md);
        for (const heading of headings) {
          expect(heading.slug.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("searchDocs", () => {
  const index = [
    { path: "docs/architecture/decisions.md", title: "decisions", content: "# ADR\n\nD39 是关卡结论。\nD39 又出现一次。" },
    { path: "docs/tasks/s6d-docs-report.md", title: "s6d-docs-report", content: "报告里提到 D39 与 D42。" },
    { path: "README.md", title: "README", content: "没有关键字。" },
  ];

  it("大小写不敏感、按命中数降序、返回片段", () => {
    const hits = searchDocs(index, "d39");
    expect(hits.map((hit) => hit.path)).toEqual([
      "docs/architecture/decisions.md",
      "docs/tasks/s6d-docs-report.md",
    ]);
    expect(hits[0]!.count).toBe(2);
    expect(hits[0]!.snippets.length).toBe(2);
    expect(hits[1]!.count).toBe(1);
  });

  it("空查询返回空数组", () => {
    expect(searchDocs(index, "   ")).toEqual([]);
  });

  it("属性：任意查询下命中的文档都真的包含该关键词（fast-check）", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 8 }), (query) => {
        const needle = query.trim().toLowerCase();
        if (needle.length === 0) return;
        for (const hit of searchDocs(index, query)) {
          const doc = index.find((entry) => entry.path === hit.path)!;
          expect(doc.content.toLowerCase()).toContain(needle);
        }
      }),
      { numRuns: 300 },
    );
  });
});
