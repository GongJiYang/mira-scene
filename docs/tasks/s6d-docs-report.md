# S6d 执行报告：界面内置开发文档窗口（D21）

> 执行者：Command Code（DeepSeek）。日期：2026-10-27。
> 任务：`docs/tasks/s6d-docs.md`。工作目录：worktree `/Users/gjy/mira-wt-s6d`（分支 `s6d-docs`，基于 `9555a76`）。
> 全程**未 commit**；未读 `.env`；未访问/修改 `/Users/gjy/mira-scene`；未改 `skills/live2d-auto/*`、`tools/live2d-pipeline/*`。

---

## 0. 结论速览

| 项 | 状态 |
|---|---|
| §0 YAGNI 范围（只读阅读页：目录树 + 正文 + 标题锚点 + 全文搜索 + 手机适配） | ✅ 完成，未做编辑/评论/版本对比/打开源码 |
| §0 端口/适配器（构建时静态数据，独立路由 `?docs=1`，不依赖直播间 UI） | ✅ 完成 |
| §0 函数式核心（`buildDocTree` / `extractHeadings` / `slugify` / `searchDocs`） | ✅ 完成，React 组件只负责展示 |
| §0 契约（白名单；`.log`/`.env*`/隐藏文件永不收录；禁止原始 HTML） | ✅ 完成，属性测试 + e2e 断言 |
| §1 收录范围 + `import.meta.glob(..., "?raw")` 按需加载 | ✅ 完成（每篇文档独立 chunk，非 eager） |
| §2 界面（桌面三栏 + 顶部搜索；手机抽屉；GFM 表格；CSS 变量深色粉紫；URL 记住文档与锚点） | ✅ 完成 |
| §3 e2e 端口改环境变量，默认值不变 | ✅ 完成（只改这一处） |
| §4 测试与验收 | ✅ `pnpm test` 562 passed、`pnpm typecheck` 通过、`pnpm e2e` 18 passed / 16 skipped |
| 截图 | ✅ `e2e/out/docs-desktop.png`、`e2e/out/docs-mobile.png` |

**需要 Claude 裁定的一处架构改动**：为满足 §1「用 `import.meta.glob` 收录仓库根 `docs/`」，把 Vite `root` 从 `apps/client` 上移到仓库根（详见 §5.1）。这是本批唯一超出「新增文件」的改动，影响面已用全量 e2e 验证。

---

## 1. 改了哪些文件

### 新增

| 文件 | 作用 |
|---|---|
| `apps/client/src/docs/core.ts` | 纯函数核心：`isIncluded`（白名单）、`buildDocTree`、`titleOf`、`slugify`、`extractHeadings`、`searchDocs` |
| `apps/client/src/docs/registry.ts` | `import.meta.glob(..., { query: "?raw", import: "default" })` 懒加载登记表 |
| `apps/client/src/docs/docsText.ts` | 界面上所有用户可见文案（铁律 4） |
| `apps/client/src/docs/DocsApp.tsx` | 页面外壳：目录树 / 正文 / 大纲 / 搜索 / 抽屉 / URL 同步 |
| `apps/client/src/docs/MarkdownView.tsx` | `react-markdown` + `remark-gfm`，标题 id 用 `slugify`，**不装 `rehype-raw`** |
| `apps/client/src/docs/docs.css` | 深色粉紫主题（CSS 变量）、三栏布局、手机抽屉 |
| `apps/client/test/docs.test.ts` | 15 条单测（含 4 组 fast-check 属性测试） |
| `e2e/docs.spec.ts` | 3 条 e2e（桌面 / 手机 / 契约） |

### 修改

| 文件 | 改动 |
|---|---|
| `apps/client/src/main.tsx` | 新增 `?docs=1` 路由分支（在 `?preview=yuna` 之前判断） |
| `apps/client/vite.config.ts` | `root` 上移到仓库根 + `publicDir` / `build.outDir` / `rollupOptions.input` 指回 `apps/client`；新增 dev 中间件把 `/` 改写为客户端入口；`cacheDir` 放回 `apps/client`（见 §5.1） |
| `apps/client/index.html` | 入口脚本路径 `/src/main.tsx` → `/apps/client/src/main.tsx`（root 上移的连带改动） |
| `apps/client/package.json` | 新增依赖 `react-markdown@^10.1.0`、`remark-gfm@^4.0.1` |
| `playwright.config.ts` | 端口读 `E2E_SERVER_PORT` / `E2E_CLIENT_PORT`，默认仍为 `8887` / `5273`（§3 唯一改动点） |
| `pnpm-lock.yaml` | 上述两个依赖的锁文件更新 |

### 未触碰

`skills/live2d-auto/*`、`tools/live2d-pipeline/*`、`docs/architecture/*`、`PROGRESS.md`、`apps/server/**`、`packages/protocol/**`。

---

## 2. 新增依赖

```
react-markdown ^10.1.0
remark-gfm     ^4.0.1
```

均为 `apps/client` 的 `dependencies`。`react-markdown` 默认不解析原始 HTML，正好满足 §0 的防注入契约，因此**没有**引入 `rehype-raw`。

---

## 3. 实现要点

### 3.1 白名单（§1）

`core.ts` 里用正则表达白名单，而不是前缀匹配：

| 分组 | 规则 |
|---|---|
| 架构 | `^docs/architecture/[^/]+\.md$` |
| 报告与记录 | `^docs/ai-usage-log\.md$`、`^docs/tasks/[^/]+-report\.md$` |
| 角色 | `^characters/[^/]+/(prompt|scene)\.v1\.md$` |
| 根目录 | `^(README|AI_USAGE)\.md$` |

另有独立守卫：路径任一段以 `.` 开头即排除（隐藏文件/目录），因此 `.env*`、`.s6d-cmd.log` 等无论是否命中白名单都不会收录。

### 3.2 懒加载（§1）

`registry.ts` 用 `import.meta.glob(..., { query: "?raw", import: "default" })`，**没有** `eager`。构建产物验证：

- 每篇文档各自成为独立 chunk（`decisions-*.js`、`s6a-report-*.js` 等 14 个报告 chunk）；
- 主入口 `index-*.js` 中**不含**文档正文（`grep "架构决策记录" index-*.js` = 0 命中）。

### 3.3 纯函数（§0 关卡 3）

| 函数 | 签名 | 说明 |
|---|---|---|
| `buildDocTree` | `(paths: readonly string[]) => DocGroup[]` | 过滤白名单 → 分组 → 组内按标题排序 → 丢弃空分组 |
| `extractHeadings` | `(md: string) => Heading[]` | ATX 标题；跳过 ``` 围栏内；去行内标记；同文档 slug 去重（`-1`、`-2`） |
| `slugify` | `(text: string) => string` | 小写、空白→`-`、去标点（保留 `\p{L}\p{N}`）、空结果回落 `section` |
| `searchDocs` | `(index, query, maxSnippets=3) => SearchHit[]` | 大小写不敏感子串；返回命中文档 + 命中数 + 片段；按命中数降序 |

React 组件（`DocsApp` / `MarkdownView`）只做展示与副作用（懒加载、滚动、URL 同步），不含业务判断。

### 3.4 界面（§2）

- **桌面**：`grid-template-columns: 240px minmax(0,1fr) 220px` —— 左目录树 / 中正文 / 右本文大纲；顶部 sticky 搜索框。
- **手机**（`max-width: 900px`）：目录变 `position: fixed` 抽屉（`translateX(-100%)` + `visibility: hidden`），☰ 打开，点文档后自动收起；正文全宽；大纲隐藏。
- **Markdown**：`react-markdown` + `remark-gfm`（表格正确渲染，见截图）；代码块等宽字体；**未装 `rehype-raw`**，原始 HTML 按纯文本处理。
- **配色**：CSS 变量 `--docs-bg/--docs-panel/--docs-accent/--docs-accent-2`，深色底 + 粉紫渐变标题，与直播间风格协调。
- **URL**：`?docs=1&doc=<path>#<slug>`，用 `history.replaceState` 同步（不污染后退历史）；带锚点的分享链接可直接打开并滚动到对应标题。

### 3.5 e2e 端口（§3）

只改 `playwright.config.ts` 的端口来源，默认值 `8887` / `5273` 原样保留；其余 e2e 用例一行未动。

---

## 4. 测试与验收（§4）

| 命令 | 结果 |
|---|---|
| `pnpm install` | 已在 worktree 完成（新增 2 个依赖） |
| `pnpm test` | **562 passed**（58 文件）—— 原 547 + 本批 15 |
| `pnpm typecheck` | 通过（4 个 workspace 项目） |
| `E2E_SERVER_PORT=8987 E2E_CLIENT_PORT=5373 pnpm e2e` | **18 passed / 16 skipped / 0 failed**（3.4m） |

### 4.1 单测（`apps/client/test/docs.test.ts`，15 条）

- `isIncluded`：白名单正例 7 条；反例（任务说明、`.log`、`.env`、隐藏文件、非 md、空串）；**fast-check 属性**：任意路径段组合下 `.log` / `.env` / 隐藏文件恒为 `false`（200 次）。
- `titleOf`：去目录、去 `.md`。
- `buildDocTree`：分组归集 + 过滤；空分组丢弃 + 组内排序；**fast-check 属性**：任意路径列表输出都不含 `.log` / 隐藏文件（200 次）。
- `slugify`：大小写、中文、标点、空串回落。
- `extractHeadings`：层级、去重 slug、代码块内 `#` 不算标题、行内标记剥离；**fast-check 属性**：任意文本不抛错且 slug 非空（300 次）。
- `searchDocs`：大小写不敏感、命中数排序、片段、空查询；**fast-check 属性**：命中文档必然真的包含关键词（300 次）。

### 4.2 e2e（`e2e/docs.spec.ts`，3 条）

1. **桌面**：打开 `?docs=1` → 正文非空 → 目录树有项 → 点 `docs/tasks/s6a-report.md` 切换正文并高亮 → 大纲有项 → 带锚点链接 `#d39` 生效 → 搜索 `D39` 有结果 → 点结果跳转。
2. **手机**：抽屉默认隐藏 → ☰ 打开 → 点文档后自动收起 → URL 记住 `doc` → 无横向滚动。
3. **契约**：`docs/tasks/s6a-report.md` 里的 `<script>` 字面量只作为文本出现（`article script` = 0、`iframe` = 0、`textContent` 含 `<script>`）；目录树中无 `.log`、无隐藏路径、`docs/tasks/*` 只含 `-report.md`、不含任务说明 `s6d-docs.md`。

### 4.3 截图

- `e2e/out/docs-desktop.png`（1440×900）
- `e2e/out/docs-mobile.png`（iPhone 13，1170×1992）

两张均已人工目视核对：桌面三栏 + 搜索框 + 表格渲染正常；手机顶栏 ☰ + 搜索、抽屉收起、正文全宽、GFM 表格正常。

---

## 5. 歧义与需要裁定的事项

### 5.1【重要·架构改动】Vite `root` 上移到仓库根

- **现象**：§1 要求用 `import.meta.glob(..., { query: "?raw", import: "default" })` 收录 `docs/architecture/*.md` 等，但这些文件在 `apps/client` **之上**。实测（Vite 7.3.7）`import.meta.glob` **无法收录 root 之外的文件**：用 `../../../docs/...` 相对模式时 glob 返回空对象，构建产物里没有任何文档 chunk。
- **处理**：把 `apps/client/vite.config.ts` 的 `root` 设为仓库根，并把以下项显式指回 `apps/client`：
  - `publicDir` → `apps/client/public`（`/vendor/cubism`、`/stage/*` 等 URL 不变）
  - `build.outDir` → `apps/client/dist`
  - `build.rollupOptions.input` → `apps/client/index.html`
  - `cacheDir` → `apps/client/node_modules/.vite`（避免依赖预打包解析基准错位）
  - 新增 dev 中间件 `mira-client-entry`：把 `/` 与 `/index.html` 改写为 `/apps/client/index.html`，保持「打开 `/` 就是应用」的原有行为
  - `apps/client/index.html` 的入口脚本路径改为 `/apps/client/src/main.tsx`
- **验证**：`/`、`/?docs=1`、`/?preview=yuna`、`/vendor/cubism/...`、`/stage/assets/...` 全部 200；**全量 e2e 18 passed / 0 failed**，原有 stage / mobile / yuna-preview 用例全部通过，说明未破坏既有功能。
- **请裁定**：是否接受「Vite root 上移到仓库根」？若不接受，替代方案是把文档在构建时复制进 `apps/client`（会引入生成物或构建脚本，且与「文档和代码同步更新」的意图略有偏差）。我选择前者是因为它零生成物、文档始终是唯一真源。

### 5.2 分组标题的文案位置

- `buildDocTree` 需要给分组一个显示名（架构 / 报告与记录 / 角色 / 根目录）。按铁律 4，这些文案放在 `docsText.ts` 的 `DOCS_TEXT.groups`，`core.ts` 只引用不硬编码。

### 5.3 `docsText.ts` 里预留但未使用的键

- `searchHint`、`close`、`back` 三个键当前没有消费点（搜索框用 placeholder 已足够，抽屉用 ☰ 图标，未做「返回演出」按钮——§0 明确不做直播间入口，由 Claude 在 S6b 后添加）。保留是为了让后续加按钮时不必再动文案文件；若认为属于 YAGNI 冗余，可删。

### 5.4 搜索的索引构建时机

- §1 要求按需加载，但全文搜索需要全部文档内容。折中：**首次执行搜索时**才 `Promise.all` 加载全部文档并缓存索引（只做一次），首屏不加载。搜索结果点击后跳转到该文档（复用已加载内容）。

### 5.5 无 DOM 单测环境

- 仓库的 vitest 是 node 环境，没有 jsdom / happy-dom / testing-library。因此「禁止原始 HTML」这条契约无法用单测覆盖，改为在 e2e 里断言（§4.2 第 3 条）。未为此新增测试依赖。

---

## 6. 未做（按 §0 YAGNI）

编辑、评论、版本对比、从 UI 打开源码、直播间入口按钮（S6b 完成后由 Claude 添加）、文档内搜索高亮跳转、暗/亮主题切换。

## fix1（Claude 验收补记；cmd 卡在 e2e 超时重试循环，被 Claude 停止，测试由 Claude 跑）
- 撤回 Vite root 上移；新增 `apps/client/vite/docsPlugin.ts` 提供虚拟模块 `virtual:mira-docs`：Node 侧扫描，**白名单只调用 `core.ts` 的 `isIncluded()`**；读取前三重校验（`decodeDocPath` 拒绝 `..`/隐藏段/绝对路径/反斜杠 → `isIncluded` → `resolveWithinRoot` 确认在仓库根内）。新增 `scripts/verify-docs-build.sh` 与 `docsPlugin.test.ts`。
- Claude 实跑：`pnpm test` 573 passed；`pnpm typecheck` 通过；`verify-docs-build.sh` OK（`dist/index.html` 在根，文档各自成 chunk，主 chunk 不含正文）；`E2E_SERVER_PORT=8987 E2E_CLIENT_PORT=5373 pnpm e2e` 18 passed / 16 skipped。
