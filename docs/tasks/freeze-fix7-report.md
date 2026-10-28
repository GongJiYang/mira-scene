# freeze-fix7 报告：手机端人物变得很小（freeze-fix1 回归）

> 冻结期只修这一个 bug。执行者：Command Code（deepseek-v4-flash）。日期：2026-10-28。

## §1 根因（已核实）

freeze-fix1 §5.2 在 `apps/client/src/live/live.css` 给手机端画布写了：

```css
.live-mobile .live-live2d-canvas { top: var(--mobile-top-safe); height: auto; bottom: 0; }
```

`<canvas>` 是**替换元素**，`height: auto` 取的是 canvas 固有宽高比（来自 `width`/`height` 属性），
**不会被 `top`/`bottom` 撑开**。于是画布 CSS 尺寸在 180–215px 间塌陷，与渲染器
`resize(canvas.clientWidth, canvas.clientHeight)` / `fitModel` 的取景不一致，人物被缩小并错位。

- freeze-fix1 的 `yunaFit.test.ts` 只测纯函数，测不到真实布局这一层。
- 录制时实测：修复前画布 `clientHeight` = 180–215px（视口 780–932），人物只占屏高约 **14.2%**（≈ 1/8），
  与用户手机所见一致。

## §2 修法

- `live.css`：手机端画布高度改为显式 `height: calc(100% - var(--mobile-top-safe))`（保留 `top`，去掉 `height: auto`）。
  父容器 `.live-mobile-stage` 是 `inset: 0`（舞台全高），故 `100%` = 视口高。
- `StageRenderer.tsx`：新增 ResizeObserver 监听画布自身，布局变化后重取一次
  `resize(canvas.clientWidth, canvas.clientHeight, dpr)`（原先只在创建时 resize 一次，无监听）。
- 未改 `apps/client/src/core/scheduler.ts`、`apps/server/src/session.ts`（freeze-fix6 并行修改中）。
- 未动 `tools/live2d-pipeline/**`、`skills/**`。

## §3 修复前后包围盒高度比例（数字）

像素统计：对画布 `readPixels` 求 α > 16 的不透明像素包围盒，比例 = 包围盒高 / 视口高。

| 视口 | 修复前画布 clientHeight | 修复前比例 | 修复后画布 clientHeight | 修复后比例 |
| --- | --- | --- | --- | --- |
| 390×844 | 195px | **14.2%** | 748px | **53.1%** |
| 430×932 | 215px | **14.2%** | 836px | **54.7%** |
| 360×780 | 180px | **14.2%** | 684px | **54.1%** |

- 修复后画布 `clientHeight` == `getBoundingClientRect().height` == 视口高 − 96（顶部安全区），误差 0px。
- 修复后包围盒顶部 117–132px ≥ 标题胶囊底部 93px（未被顶栏 + 标题胶囊遮挡）。
- 修复前包围盒顶部 101–103px 也 ≥ 93px，但人物极小（14.2%）——即「悬空在坐垫上方」的那一态。

## §4 测试

新增 e2e `e2e/mobile-figure-size.spec.ts`（`iphone-13` 项目，Mock 服务由 playwright 配置启动）。
参数化三个视口：390×844 / 430×932 / 360×780。每个视口断言：

1. 画布 `clientHeight` == `getBoundingClientRect().height`，且 ≈ 视口高 − 顶部偏移（< 2px）；
2. 画布不透明像素包围盒高度 ≥ 视口高 × 0.5；
3. 包围盒顶部 ≥ 标题胶囊（`story-header`）底部。

测试名（3 条，参数化同一 spec）：

```
[iphone-13] › e2e/mobile-figure-size.spec.ts › freeze-fix7 §3 手机端人物尺寸
  › 画布高度贴合视口、人物包围盒 ≥ 50% 视口高且不被标题胶囊遮挡（390x844）
  › 画布高度贴合视口、人物包围盒 ≥ 50% 视口高且不被标题胶囊遮挡（430x932）
  › 画布高度贴合视口、人物包围盒 ≥ 50% 视口高且不被标题胶囊遮挡（360x780）
```

- 先写会失败的测试：修复前 3 条全部失败（断言 2「画布高度应 ≈ 视口高 − 顶部偏移」实收偏差 504–621px）。
- 修复后 3 条全部通过。
- 命令：`E2E_SERVER_PORT=8897 E2E_CLIENT_PORT=5284 pnpm exec playwright test e2e/mobile-figure-size.spec.ts --project=iphone-13`（timeout 600000）。
- 只跑了 §3 指定的这一个 spec；未跑其它 e2e。

## §5 验证

- `pnpm test` 全绿：109 个测试文件 / 1063 个测试通过。
- `pnpm typecheck` 全绿。
- 未 commit；未停用任何非自启动进程；测试用 Mock 模式，不发真实网络请求。

## 关卡 1–5 结论（Claude 决定，修复）

1. YAGNI：只修手机画布尺寸。
2. 端口/适配器：只动视图 CSS + 渲染器 resize 监听。
3. 函数式核心：不新增逻辑（resize 只是重算既有纯函数入参）。
4. 契约：手机端人物高度 ≥ 50% 视口且头顶不被遮挡。✓
5. 测试奖杯：真实布局 e2e（像素包围盒），补上 freeze-fix1 纯函数测试测不到的那一层。
