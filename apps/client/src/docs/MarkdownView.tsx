/**
 * Markdown 渲染（S6d §2）：`react-markdown` + `remark-gfm`。
 *
 * 契约（S6d §0）：**不允许原始 HTML**（防注入）——默认不装 `rehype-raw`，
 * 所以 Markdown 里的 `<script>` / `<img onerror>` 一律按纯文本处理。
 * 标题 id 用与 `extractHeadings` 相同的 `slugify`，保证大纲锚点能对上。
 */
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { slugify } from "./core";
import type { ReactNode } from "react";

type Props = { markdown: string };

/** 从 React 子节点里抽取纯文本，用于生成标题 slug。 */
function textOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children && typeof children === "object" && "props" in children) {
    return textOf((children as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

export function MarkdownView({ markdown }: Props) {
  const components = useMemo(() => {
    const heading = (level: number) => {
      return ({ children }: { children?: ReactNode }) => {
        const id = slugify(textOf(children));
        const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
        return (
          <Tag id={id} data-heading-level={level}>
            {children}
          </Tag>
        );
      };
    };
    return {
      h1: heading(1),
      h2: heading(2),
      h3: heading(3),
      h4: heading(4),
      h5: heading(5),
      h6: heading(6),
    };
  }, []);

  return (
    <div className="docs-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
