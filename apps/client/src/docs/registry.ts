/**
 * 构建时把仓库里的 Markdown 作为静态数据打包进来（S6d §1）。
 *
 * 数据来源是 `virtual:mira-docs`（见 `apps/client/vite/docsPlugin.ts`）：
 * 插件在 Node 侧扫描仓库根候选文件，用 `core.ts` 的 `isIncluded()` 过滤，
 * 每篇文档一个动态 import 的子虚拟模块 —— **按需加载**，不会一次性把
 * 全部文档塞进首屏包里。白名单只保留在 `core.ts` 一处。
 */
import { DOC_LOADERS } from "virtual:mira-docs";

export type DocLoader = {
  /** 仓库相对路径（`docs/architecture/decisions.md`）。 */
  path: string;
  /** 懒加载：首次调用才真正读取文件内容。 */
  load: () => Promise<string>;
};

export { DOC_LOADERS };

export const DOC_PATHS: string[] = DOC_LOADERS.map((entry) => entry.path);

/** 按路径取加载器；不存在返回 undefined。 */
export function docLoader(path: string): DocLoader | undefined {
  return DOC_LOADERS.find((entry) => entry.path === path);
}
