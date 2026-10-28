# freeze-fix7 任务说明：手机端人物变得很小（freeze-fix1 回归）

> 来源：2026-10-28 用户在手机上发现；Claude 用 iPhone 13 视口截图确认人物只占屏高约 1/8 且悬空在坐垫上方（S6b 以来约 62%）。执行者：Command Code（deepseek-v4-flash）。冻结期：只修这一个 bug。

## 铁律
冲突停下写进报告，不许绕过；Key 规则见 CLAUDE.md（D49）；**不准 commit**；不碰 `tools/live2d-pipeline/**`、`skills/**`；**可以用 Playwright 截图但不要用读文件工具打开图片**（用像素统计判断）；长命令显式 timeout；测试不发真实网络请求；**只准停自己启动的进程，禁止 `pkill -f vite` 这类宽匹配**；e2e 只跑 §3 指定的 spec。先写会失败的测试再改。**不要改 `apps/client/src/core/scheduler.ts`、`apps/server/src/session.ts`**（freeze-fix6 正在并行修改）。

## §1 根因（已核实）
- freeze-fix1 §5.2 在 `apps/client/src/live/live.css` 写了 `.live-mobile .live-live2d-canvas { top: var(--mobile-top-safe); height: auto; bottom: 0; }`。`<canvas>` 是替换元素，`height: auto` 取 canvas 固有宽高比，**不会被 top/bottom 撑开**，画布 CSS 尺寸与渲染器 `resize(canvas.clientWidth, canvas.clientHeight)` / `fitModel` 的取景不一致，人物被缩小并错位。
- freeze-fix1 的 `yunaFit.test.ts` 只测了纯函数，没有在真实布局里验证。

## §2 修法
- 手机端画布高度改为显式：`height: calc(100% - var(--mobile-top-safe))`（保留 `top`，去掉 `height: auto`）；确认画布父容器高度为舞台全高。确保 resize 监听在布局变化后触发一次（若已有 ResizeObserver 则无需改）。
- 目标：人物头顶不被顶栏 + 标题胶囊遮挡（freeze-fix1 的目的保留），同时人物大小恢复到 freeze-fix1 之前的水平（人物可见高度 ≥ 视口高度的 50%），脚落在坐垫上（接触阴影随画布对齐）。

## §3 测试
- 新增 e2e `e2e/mobile-figure-size.spec.ts`（iphone-13 项目，Mock 服务由 playwright 配置启动）：打开 `/`，等 `yuna-canvas` 可见并稳定 3s，对画布 `readPixels` 或截图做像素统计，求不透明像素的包围盒：断言 **包围盒高度 ≥ 视口高度 × 0.5**，且 **包围盒顶部 ≥ 标题胶囊（`story-header`）底部**；同时断言画布 `clientHeight` 与 `getBoundingClientRect().height` 相等且 ≈ 视口高度 − 顶部偏移（误差 < 2px）。修复前此用例应失败。
- 另在 390×844、430×932、360×780 三个视口跑同一断言（同一 spec 内参数化）。
- 命令：`pnpm exec playwright test e2e/mobile-figure-size.spec.ts --project=iphone-13`（显式 timeout 600000）。
- `pnpm test`、`pnpm typecheck` 全绿。

## §4 报告
`docs/tasks/freeze-fix7-report.md`：修复前后包围盒高度比例（数字）、改动、测试名。

## 关卡 1–5 结论（Claude 决定，修复）
1. YAGNI：只修手机画布尺寸。2. 端口/适配器：只动视图 CSS。3. 函数式核心：不新增逻辑。4. 契约：手机端人物高度 ≥ 50% 视口且头顶不被遮挡。5. 测试奖杯：真实布局 e2e（像素包围盒），补上 freeze-fix1 纯函数测试测不到的那一层。
