declare module "virtual:mira-docs" {
  export type DocLoader = {
    /** 仓库相对路径（`docs/architecture/decisions.md`）。 */
    path: string;
    /** 懒加载：首次调用才真正读取文件内容。 */
    load: () => Promise<string>;
  };
  export const DOC_LOADERS: DocLoader[];
}
