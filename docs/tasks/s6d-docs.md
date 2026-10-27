# S6d 任务说明：界面内置开发文档窗口（D21）

> 用户 2026-10-27 授权「能并行的一起派发，Claude 审核」。关卡 1–5 由 Claude 裁定（见 §0），记入 decisions.md D42。
> **在独立 worktree 里执行**：`/Users/gjy/mira-wt-s6d`（分支 `s6d-docs`，基于 9555a76）。主目录 `/Users/gjy/mira-scene` 正在跑另一批（S6b），**不许碰主目录**。

## 铁律
1. 冲突时停下写进报告；不许改需求或绕过。
2. 不准 commit（Claude 验收后提交、合并）。不读 `.env`（本批不需要任何 Key）。
3. 不改 `skills/live2d-auto/*`、`tools/live2d-pipeline/*`。
4. 不写面向用户的文案；界面上的占位文字放进 `apps/client/src/docs/docsText.ts`。

## §0 关卡结论（Claude 裁定）
| 关卡 | 结论 |
|---|---|
| YAGNI | 只做：只读的文档阅读页（目录树 + 正文 + 标题锚点 + 全文搜索 + 手机适配）。不做：编辑、评论、版本对比、从 UI 里打开源码 |
| 端口/适配器 | 文档是构建时的静态数据，不经服务端；入口是独立路由 `?docs=1`，**不依赖直播间 UI**（S6b 完成后由 Claude 在直播间加一个入口按钮） |
| 函数式核心 | 纯函数：`buildDocTree(paths)`、`extractHeadings(md)`、`slugify(text)`、`searchDocs(index, query)`（返回命中文档 + 片段）。React 组件只负责展示 |
| 契约 | 收录范围只用白名单（见 §1）；任何 `.log`、`.env*`、隐藏文件永不收录（属性测试）。Markdown 渲染不允许原始 HTML（防注入） |
| 测试奖杯 | 单测纯函数（含 fast-check）；e2e 打开 `?docs=1`、点目录、搜索 `D39` 能命中。不联网 |

## §1 收录范围（白名单）
- `docs/architecture/*.md`（decisions、roadmap 等）
- `docs/ai-usage-log.md`
- `docs/tasks/*-report.md`（只收报告，不收任务说明和 `.log`）
- `characters/*/prompt.v1.md`、`characters/*/scene.v1.md`（提示词也是设计的一部分）
- 根目录 `README.md`、`AI_USAGE.md`（如果存在）
用 Vite 的 `import.meta.glob(..., { query: "?raw", import: "default" })` 按需加载（不要一次性 eager 打包全部）。

## §2 界面
- 桌面：左侧目录树（按上面的分组），中间正文，右侧本文标题大纲；顶部搜索框。
- 手机：目录收进抽屉，正文全宽。
- Markdown：`react-markdown` + `remark-gfm`（表格要正确显示），代码块等宽字体；**禁用原始 HTML**。
- 颜色用 CSS 变量，深色背景，和直播间的粉紫风格协调即可（不必像素级统一）。
- URL 记住当前文档和锚点（`?docs=1&doc=<path>#<slug>`），可直接分享链接。

## §3 e2e 端口
`playwright.config.ts` 现在写死了 `8887 / 5273`，与主目录的 S6b 会冲突。改成读环境变量 `E2E_SERVER_PORT` / `E2E_CLIENT_PORT`，**默认值保持 8887 / 5273 不变**；本批跑 e2e 时用 `E2E_SERVER_PORT=8987 E2E_CLIENT_PORT=5373`。只改这一处，别的 e2e 用例不动。

## §4 测试与验收
`pnpm install`（worktree 里需要装一次依赖）后：`pnpm test`、`pnpm typecheck`、`E2E_SERVER_PORT=8987 E2E_CLIENT_PORT=5373 pnpm e2e` 全部通过。新增 e2e `e2e/docs.spec.ts`，截图存 `e2e/out/docs-{desktop,mobile}.png`。

## §5 报告
写在 `docs/tasks/s6d-docs-report.md`：改了哪些文件、新增依赖、测试数、截图路径、歧义。
