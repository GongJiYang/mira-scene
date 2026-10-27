/** 界面上的所有用户可见文案集中在这里（铁律 4：不写面向用户的文案到别处）。 */
export const DOCS_TEXT = {
  title: "开发文档",
  searchPlaceholder: "搜索文档…",
  searchLabel: "搜索",
  searchEmpty: "没有匹配的文档",
  toc: "本文大纲",
  tree: "目录",
  empty: "这份文档没有正文",
  loading: "正在加载…",
  resultCount: (n: number) => `${n} 处命中`,
  /** 目录树分组标题。 */
  groups: {
    architecture: "架构",
    reports: "报告与记录",
    characters: "角色",
    root: "根目录",
  },
} as const;
