# freeze-fix8 任务说明：手机端打不开 / 点麦克风没反应

> 来源：2026-10-28 用户手机实测失败；Claude 用 Playwright WebKit（iPhone 13）复现。执行者：Command Code（deepseek-v4-flash）。冻结期：只修这三条。

## 铁律
冲突停下写进报告，不许绕过；Key 规则见 CLAUDE.md（D49）；**不准 commit**；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开图片；长命令显式 timeout；测试不发真实网络请求；**只准停自己启动的进程，禁止 `pkill -f vite` 这类宽匹配**；e2e 只跑 §4 指定的 spec。先写会失败的测试再改。不改视觉设计（颜色、布局）。

## §1 Google Fonts 阻塞渲染（高）
- 现象：WebKit 打开本地页面 `load` 超过 60s，控制台 `Failed to preconnect to https://fonts.googleapis.com/`。国内网络无法访问 Google，手机端白屏 / 打不开。
- 根因：`apps/client/index.html` 第 8–11 行 `preconnect` + `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC...&family=VT323...">`，阻塞渲染。
- 修法：删除对 Google Fonts 的全部引用。中文字体改用系统字体栈（`"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif`，Noto 只作为本机已装时的候选，不再下载）；VT323（顶栏 LIVE / viewer 等等宽像素字）改为**自托管**：把字体文件放进 `apps/client/public/fonts/`（来源：npm 包 `@fontsource/vt323` 已在 pnpm 离线缓存则用它；否则从 Google Fonts 下载一次 woff2 放入仓库，在报告写明来源与许可证 OFL），用 `@font-face` + `font-display: swap` 引入。全仓 grep 不得再出现 `fonts.googleapis` / `fonts.gstatic`。
- 测试：单测或脚本断言 `index.html` 与所有 css 不含 `fonts.googleapis` / `fonts.gstatic`。

## §2 手机点一下麦克风没有任何反应（中）
- 现象：手机端麦克风是「按住说话」，用户**点一下**（短按）时录音 <300ms 被丢弃（`recorder.ts` `MIN_RECORDING_MS`），界面没有任何反馈，用户以为坏了。
- 修法：短按（按下到松开 < 300ms）时，在输入区附近显示 2s 轻提示，文案放 `uiText.ts` 新键 `pttHoldHint`：`按住麦克风说话，松开发送`（Claude 定稿）；桌面同样适用。样式复用现有轻提示样式。
- 测试：单测（短按判定纯函数）+ 视图显隐。

## §3 非 HTTPS 页面下麦克风不可用却没有提示（中）
- 现象：线上是 `http://<IP>`，浏览器不提供 `navigator.mediaDevices`（`isSecureContext === false`），按麦克风无反应。
- 修法：启动时检测 `window.isSecureContext && navigator.mediaDevices?.getUserMedia`；不可用时按麦克风 → 显示提示，文案 `uiText.ts` 新键 `micUnavailableHint`：`当前页面不是 HTTPS，浏览器不允许录音；可以先发弹幕聊天`（Claude 定稿），并且不进入 listening 状态；录音权限被拒（NotAllowedError）时同样提示 `micDeniedHint`：`麦克风权限被拒绝了，可以在浏览器设置里打开，或者先发弹幕`。
- 测试：单测（可用性判定纯函数）；e2e 见 §4。

## §4 e2e（只跑这一个）
新增 `e2e/mobile-mic-hints.spec.ts`（iphone-13 项目）：① 页面不请求任何 `fonts.googleapis.com` / `fonts.gstatic.com`（监听 request）；② 短按麦克风 → 出现 `pttHoldHint`；③ 用 `addInitScript` 把 `navigator.mediaDevices` 置为 undefined 模拟非安全上下文 → 按麦克风出现 `micUnavailableHint` 且 state-chip 不变成 listen。命令：`E2E_SERVER_PORT=8897 E2E_CLIENT_PORT=5284 pnpm exec playwright test e2e/mobile-mic-hints.spec.ts --project=iphone-13`（显式 timeout 600000）。另外跑一次 `--project=desktop` 的 `e2e/ptt-hold.spec.ts` 确认桌面按住说话不受影响。
- `pnpm test`、`pnpm typecheck` 全绿，`pnpm smoke` 通过。

## §5 报告
`docs/tasks/freeze-fix8-report.md`：改动、字体来源与许可证、测试名、歧义。

## 关卡 1–5 结论（Claude 决定，修复）
1. YAGNI：只修字体阻塞与两类麦克风提示。2. 端口/适配器：视图层与静态资源，协议不变。3. 函数式核心：短按判定、麦克风可用性判定为纯函数。4. 契约：页面不依赖任何境外字体服务；麦克风不可用时必有可读提示且不进入 listening。5. 测试奖杯：纯函数单测 + 一个手机 e2e。
