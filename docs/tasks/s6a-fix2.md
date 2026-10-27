# S6a-fix2：忧奈预览构图（用户反馈：人物偏小、显示不全）

> s6a.md 的铁律全部有效。授权范围：`apps/client/src/render/live2d/cubism/**`、`apps/client/src/preview/**`、`e2e/yuna-preview.spec.ts`、追加 `docs/tasks/s6a-report.md` 末尾「fix2」一节。

## 要求
1. 画布填满预览页左侧区域（去掉现在的小卡片尺寸），随窗口大小自适应（ResizeObserver + devicePixelRatio，上限 2）。
2. 构图：人物**完整显示**（头顶的耳朵到画面底部的腿都不被裁掉，左右不出画），并且尽量大：人物高度约占画布高度的 92%，水平居中。
3. 构图常量（缩放、X/Y 偏移）集中在一处，分 `desktop` / `mobile` 两组；构图计算写成纯函数 `fitModel(canvasW, canvasH, modelBounds, preset) → {scale, x, y}` 并单测（任意画布宽高比下，人物包围盒都在画布内）。
4. 人物包围盒用模型的可见区域计算（可以离线实测一次后写成常量 `MODEL_BOUNDS`，注明测量方法），不要用 5775×8000 的整张画布。
5. e2e：桌面 1440×900 和手机 390×844 各截一张 `e2e/out/yuna-fit-{desktop,mobile}.png`；断言画布四边各 4px 宽的条带内没有非透明像素（即人物没有碰边被裁）。

## 验收
`pnpm test`、`pnpm typecheck`、`pnpm e2e` 通过；报告「fix2」一节写清 `MODEL_BOUNDS` 的测量方法和两组常量。
