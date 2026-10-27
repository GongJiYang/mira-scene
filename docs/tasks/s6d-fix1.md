# S6d-fix1：撤回「Vite root 上移」，改用虚拟模块插件（Claude 裁定）

> s6d-docs.md 的铁律继续有效。工作目录：worktree `/Users/gjy/mira-wt-s6d`，不许碰 `/Users/gjy/mira-scene`。
> **当前模型不支持看图：不要用读文件工具打开任何 png/jpg**，需要核对时用脚本打印数字或文本。

## 裁定：不接受 §5.1 的 root 上移
理由：① 开发服务器会把整个仓库当网站根目录提供（`apps/server/src`、`characters/`、`tools/` 都能被 URL 访问），暴露面过大；② 生产构建的 HTML 输出路径会跟着变（`dist/apps/client/index.html` 一类），会破坏部署；③ 为一个文档功能改动整个前端的构建基础，违反最小影响原则。

## 改法
1. **撤回**：`apps/client/vite.config.ts` 恢复 `root` 默认值（`apps/client`），删掉 `clientEntryPlugin`、`cacheDir`/`publicDir`/`build.rollupOptions.input` 等为 root 上移加的配置（`build.outDir` 恢复默认）；`apps/client/index.html` 的入口脚本恢复成 `/src/main.tsx`。`server.fs.allow` 不需要放开整个仓库。
2. **新增 Vite 插件** `apps/client/vite/docsPlugin.ts`，提供虚拟模块 `virtual:mira-docs`：
   - 在 Node 里扫描仓库根下的候选文件，**用 `src/docs/core.ts` 的 `isIncluded()` 过滤**——白名单只保留这一处（删掉 `registry.ts` 里重复的 glob 模式）。
   - 虚拟模块导出 `DOC_LOADERS`：每篇文档一个**动态 import 的子虚拟模块**（例如 `virtual:mira-docs/<encoded path>`），保持按需加载、每篇一个 chunk。
   - 对每个收录的文件调用 `this.addWatchFile()`；开发时文档变动要能热更新（`handleHotUpdate` 里让对应虚拟模块失效）。
   - 插件里**只读白名单命中的文件**，读取前再校验一次 `isIncluded(path)`，并拒绝任何 `..` 或绝对路径（防止路径穿越）。
3. `registry.ts` 改为从 `virtual:mira-docs` 导入；`DocsApp.tsx` 等调用方不变。加一个 `virtual:mira-docs` 的类型声明。
4. §5.3 里预留但没用到的三个文案键（`searchHint`、`close`、`back`）删掉（YAGNI）。

## 测试
- 单测：插件的纯函数部分（扫描结果 → 过滤 → 路径编码/解码、拒绝 `..` 与绝对路径）抽成纯函数并单测，含 fast-check：任意路径字符串都不会被解码成仓库外的路径。
- **构建验证**：`pnpm --filter @mira/client build` 成功，且 `apps/client/dist/index.html` 存在（入口 HTML 在 dist 根目录），`dist` 里能找到至少一个文档 chunk；把这两条做成一个脚本或测试断言。
- `pnpm test`、`pnpm typecheck`、`E2E_SERVER_PORT=8987 E2E_CLIENT_PORT=5373 pnpm e2e` 全部通过。

## 报告
追加到 `docs/tasks/s6d-docs-report.md` 末尾「fix1」一节。
