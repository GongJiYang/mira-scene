/**
 * 开发文档窗口（S6d）。URL 带 `?docs=1` 时由 `main.tsx` 渲染。
 *
 * 布局：桌面 = 左侧目录树 / 中间正文 / 右侧本文大纲 + 顶部搜索框；
 * 手机 = 目录收进抽屉，正文全宽。
 * URL 记住当前文档与锚点：`?docs=1&doc=<path>#<slug>`，可直接分享。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildDocTree, extractHeadings, searchDocs, type DocEntry, type SearchHit } from "./core";
import { DOC_PATHS, docLoader } from "./registry";
import { DOCS_TEXT } from "./docsText";
import { MarkdownView } from "./MarkdownView";
import "./docs.css";

/** 解析 `?docs=1&doc=<path>#<slug>` 里的文档路径与锚点。 */
function readUrl(): { doc: string | null; anchor: string | null } {
  const params = new URLSearchParams(window.location.search);
  return {
    doc: params.get("doc"),
    anchor: window.location.hash.replace(/^#/, "") || null,
  };
}

/** 把当前文档与锚点写回 URL（`replaceState`，不污染后退历史）。 */
function writeUrl(doc: string | null, anchor: string | null): void {
  const params = new URLSearchParams(window.location.search);
  params.set("docs", "1");
  if (doc !== null) params.set("doc", doc);
  else params.delete("doc");
  const hash = anchor !== null && anchor.length > 0 ? `#${anchor}` : "";
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}${hash}`);
}

export function DocsApp() {
  const tree = useMemo(() => buildDocTree(DOC_PATHS), []);
  const allDocs = useMemo<DocEntry[]>(() => tree.flatMap((group) => group.docs), [tree]);

  const initial = useMemo(readUrl, []);
  const [selected, setSelected] = useState<string | null>(initial.doc);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState<{ path: string; title: string; content: string }[] | null>(null);

  const articleRef = useRef<HTMLDivElement>(null);

  const activeDoc = selected ?? allDocs[0]?.path ?? null;

  // 选中文档变化 → 懒加载内容。
  useEffect(() => {
    if (activeDoc === null) return;
    const loader = docLoader(activeDoc);
    if (!loader) {
      setContent("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    loader
      .load()
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch(() => {
        if (!cancelled) setContent(DOCS_TEXT.empty);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeDoc]);

  // 锚点：内容加载后滚动到对应标题。
  useEffect(() => {
    if (loading) return;
    const target = initial.anchor;
    if (!target || !articleRef.current) return;
    const el = articleRef.current.querySelector(`[id="${CSS.escape(target)}"]`);
    if (el) el.scrollIntoView({ block: "start" });
    // 只在首次加载对应文档时定位。
  }, [loading, initial.anchor]);

  const headings = useMemo(() => extractHeadings(content), [content]);

  // 搜索结果：首次搜索时构建索引（懒加载全部文档，只做一次）。
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const runSearch = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      if (value.length === 0) {
        setHits(null);
        return;
      }
      let index = searchIndex;
      if (index === null) {
        const loaded = await Promise.all(
          allDocs.map(async (doc) => {
            const loader = docLoader(doc.path);
            const text = loader ? await loader.load() : "";
            return { path: doc.path, title: doc.title, content: text };
          }),
        );
        index = loaded;
        setSearchIndex(loaded);
      }
      setHits(searchDocs(index, value));
    },
    [allDocs, searchIndex],
  );

  const openDoc = useCallback((path: string, anchor: string | null = null) => {
    setSelected(path);
    setDrawerOpen(false);
    setHits(null);
    setQuery("");
    writeUrl(path, anchor);
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <main className="docs-root" data-testid="docs-app">
      <header className="docs-topbar">
        <button
          type="button"
          className="docs-drawer-toggle"
          aria-label={DOCS_TEXT.tree}
          aria-expanded={drawerOpen}
          data-testid="docs-drawer-toggle"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          ☰
        </button>
        <span className="docs-brand">{DOCS_TEXT.title}</span>
        <form
          className="docs-search"
          data-testid="docs-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch(query);
          }}
        >
          <input
            type="search"
            value={query}
            aria-label={DOCS_TEXT.searchLabel}
            placeholder={DOCS_TEXT.searchPlaceholder}
            data-testid="docs-search-input"
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value.trim().length === 0) setHits(null);
            }}
          />
          <button type="submit">{DOCS_TEXT.searchLabel}</button>
        </form>
      </header>

      <div className="docs-body">
        <nav
          className="docs-tree"
          data-testid="docs-tree"
          data-open={drawerOpen ? "1" : "0"}
          aria-label={DOCS_TEXT.tree}
        >
          {tree.map((group) => (
            <section key={group.id} className="docs-group">
              <h2 className="docs-group-label">{group.label}</h2>
              <ul>
                {group.docs.map((doc) => (
                  <li key={doc.path}>
                    <button
                      type="button"
                      className="docs-tree-item"
                      data-testid="docs-tree-item"
                      data-path={doc.path}
                      data-active={doc.path === activeDoc ? "1" : "0"}
                      onClick={() => openDoc(doc.path)}
                    >
                      {doc.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>

        <div className="docs-main">
          {hits !== null ? (
            <section className="docs-results" data-testid="docs-results">
              <p className="docs-results-count">{DOCS_TEXT.resultCount(hits.length)}</p>
              {hits.length === 0 ? (
                <p data-testid="docs-no-results">{DOCS_TEXT.searchEmpty}</p>
              ) : (
                <ul>
                  {hits.map((hit) => (
                    <li key={hit.path}>
                      <button
                        type="button"
                        className="docs-result-item"
                        data-testid="docs-result-item"
                        data-path={hit.path}
                        onClick={() => openDoc(hit.path)}
                      >
                        <span className="docs-result-title">{`${hit.title} (${hit.count})`}</span>
                      </button>
                      <ul className="docs-snippets">
                        {hit.snippets.map((snippet, index) => (
                          <li key={index}>{snippet}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <article className="docs-article" data-testid="docs-article" ref={articleRef}>
              {loading ? (
                <p className="docs-loading">{DOCS_TEXT.loading}</p>
              ) : content.length === 0 ? (
                <p>{DOCS_TEXT.empty}</p>
              ) : (
                <MarkdownView markdown={content} />
              )}
            </article>
          )}
        </div>

        <aside className="docs-toc" data-testid="docs-toc" aria-label={DOCS_TEXT.toc}>
          <h2 className="docs-group-label">{DOCS_TEXT.toc}</h2>
          <ul>
            {headings.map((heading) => (
              <li key={heading.slug} data-level={heading.level}>
                <a href={`#${heading.slug}`} data-testid="docs-toc-item" onClick={() => writeUrl(activeDoc, heading.slug)}>
                  {heading.text}
                </a>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </main>
  );
}
