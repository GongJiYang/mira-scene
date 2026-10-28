# freeze-fix8 报告：手机端打不开 / 点麦克风没反应

> 执行者：Command Code（deepseek-v4-flash）。冻结期只修 §1–§3 三条；未 commit。

## 改动清单

### §1 Google Fonts 阻塞渲染（高）
- `apps/client/index.html`：删除 `preconnect`（fonts.googleapis / fonts.gstatic）与 Google Fonts `<link rel="stylesheet">`（原第 8–11 行）。
- `apps/client/src/live/live.css`：
  - 新增 `@font-face`（`font-family: "VT323"`，`font-display: swap`，`src: url("/fonts/vt323-latin-400-normal.woff2")`）。
  - `--font-body` 改为系统字体栈：`"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif`（Noto 只作本机已装时的候选）。
  - `--font-mono` 保持 `"VT323", ui-monospace, "Menlo", "Courier New", monospace`，VT323 现在由自托管文件提供。
- 新增 `apps/client/public/fonts/vt323-latin-400-normal.woff2`（17668 字节）。

**字体来源与许可证**
- 来源：npm 包 `@fontsource/vt323@5.0.13`，文件 `files/vt323-latin-400-normal.woff2`（经 jsdelivr CDN 取一次，放入仓库自托管）。pnpm 离线缓存中无 `@fontsource/vt323`，故按任务说明从 Google Fonts 分发渠道取一次 woff2。
- 许可证：**SIL Open Font License 1.1（OFL-1.1）**，`Copyright 2011, The VT323 Project Authors`。许可证全文随字体放入 `apps/client/public/fonts/VT323-LICENSE.txt`。

### §2 手机短按麦克风无反馈（中）
- `apps/client/src/live/uiText.ts`：新增键 `pttHoldHint` = `按住麦克风说话，松开发送`。
- `apps/client/src/live/micHints.ts`（新）：`SHORT_PRESS_MS = 300`、纯函数 `isShortPress(heldMs)`。
- `apps/client/src/live/micHintStore.ts`（新）：`useMicHintStore` + `showMicHint`（2s 自动消失，`MIC_HINT_DURATION_MS = 2000`）。
- `apps/client/src/live/Live.tsx`：`startPtt` 记录按下时刻，`endPtt` 松开时若 `isShortPress` → `showMicHint(UI_TEXT.pttHoldHint)`。桌面 / 手机走同一条 PTT 路径，均生效。
- 样式：`.live-mic-hint`（复用琥珀色轻提示色调，手机端绝对定位贴输入胶囊上方）。

### §3 非 HTTPS 下麦克风不可用却无提示（中）
- `apps/client/src/live/uiText.ts`：新增键 `micUnavailableHint` = `当前页面不是 HTTPS，浏览器不允许录音；可以先发弹幕聊天`、`micDeniedHint` = `麦克风权限被拒绝了，可以在浏览器设置里打开，或者先发弹幕`。
- `apps/client/src/live/micHints.ts`：纯函数 `micAvailability(env)`、`blocksMic(env)`、`isPermissionDenied(error)`，外壳 `readMicEnv()`（读 `window.isSecureContext` + `navigator.mediaDevices.getUserMedia`；非真实浏览器返回 `null`，不预判）。
- `apps/client/src/core/recorder.ts`：`start()` 返回类型由 `boolean` 改为 `StartResult`（`{ started: true }` 或 `{ started: false, reason: "denied" | "unavailable" }`），`NotAllowedError` 归为 `denied`。
- `apps/client/src/core/controller.ts`：`pttDown()` 先做可用性判定——不可用 → 显示 `micUnavailableHint` 并 **直接 return（不进入 listening）**；`recorder.start()` 失败 → `denied` 显示 `micDeniedHint`、否则 `micUnavailableHint`，随后 `INPUT_CANCELLED` 回 idle。

## 测试名

### 单测（新增 / 修改）
- `apps/client/test/micHints.test.ts`（新，13 例）：`isShortPress` 边界（0 / 299 / 300 / 非有限 / 负值）；`micAvailability` 四象限；`isPermissionDenied`；`readMicEnv`/`blocksMic`（无 window → 不拦截；安全+有 → 可用；非安全 → 拦截；无 mediaDevices → 拦截）。
- `apps/client/test/fontSelfHost.test.ts`（新，3 例）：`index.html` 不含 `fonts.googleapis`/`fonts.gstatic`；全仓 `**/*.css` 不含两者；VT323 自托管文件存在且 css 有 `@font-face ... VT323`。
- `apps/client/test/recorder.test.ts`（改）：`start()` 断言改为 `{ started: true }`；新增 `NotAllowedError → reason:"denied"`、其他错误 → `reason:"unavailable"`。
- `apps/client/test/controller.test.ts`（改）：`fakeRecorder` 返回 `StartResult`；拒绝用例返回 `{ started:false, reason:"denied" }`。

### e2e
- `e2e/mobile-mic-hints.spec.ts`（新，iphone-13）：
  - `freeze-fix8 §4 手机端麦克风提示 › ① 页面不请求 Google Fonts`
  - `… › ② 短按麦克风 → 出现 pttHoldHint`
  - `… › ③ 非安全上下文 → micUnavailableHint，且状态牌不变 listen`

命令与结果：
- `E2E_SERVER_PORT=8897 E2E_CLIENT_PORT=5284 pnpm exec playwright test e2e/mobile-mic-hints.spec.ts --project=iphone-13` → **3 passed**。
- `E2E_SERVER_PORT=8897 E2E_CLIENT_PORT=5284 pnpm exec playwright test e2e/ptt-hold.spec.ts --project=desktop` → **1 passed**（桌面按住说话不受影响）。
- `pnpm test` → **1091 passed（112 文件）**。
- `pnpm typecheck` → 全部通过。
- `pnpm smoke` → **SMOKE OK**。

## 歧义 / 假设
1. **可用性判定的测试环境**：`pttDown` 新增的可用性预判若在无 `window` 的环境（node 单测）一律判「不可用」，会破坏既有 `controller.test.ts`。据此把 `readMicEnv()` 在无 `window` 时返回 `null`（非真实浏览器，不预判），由 recorder 兜底——保持既有行为，浏览器内仍如实判定。真实浏览器 `http://<IP>` 下 `navigator.mediaDevices` 为 undefined，判定为 `insecure`/`unsupported`，拦截生效。
2. **§3「不进入 listening」**：通过在 `pttDown` 内前置拦截实现（而非先 listening 再回退），e2e ③ 据此断言 state-chip 不变 `listen`。
3. **§2 短按提示的触发位置**：放在 `Live.tsx` 的 PTT 外壳（`performance.now()` 计时），而非 controller——因为 controller 的 `stop()` 对「短按」与「录音失败」都返回 null，无法区分，放外壳才能只在短按时提示。
4. **字体来源**：`@fontsource/vt323` 不在本机 pnpm 离线缓存，按任务说明从分发渠道下载一次 woff2 入库；许可证随附 OFL-1.1 全文。
5. **不改视觉设计**：新增提示沿用现有轻提示样式与设计 token（`--think` 琥珀），未改颜色 / 布局。

## 续修（freeze-fix4 回归：手机端空闲也预留声波槽位）

### 现象与根因
- **现象**（WebKit iPhone 13 截图）：手机端底部输入栏，麦克风按钮右边空出一大块（96px），输入框被挤窄，占位文案只显示到「发条弹幕，或按住」。
- **根因**：freeze-fix4 §2 为「防按钮位移」给声波加了固定宽度槽位 `.live-wave-slot { width: 76px; flex-shrink: 0 }`，桌面端有效（按钮右移零位移），但手机端该槽位**空闲时也占位**——输入条 `.live-mobile-compose` 是 flex 行，槽位恒定吃掉 76px，把麦克风按钮往左挤、输入框变窄。实测量得空闲时麦克风按钮右边缘距视口右边缘 **96px**（76px 槽位 + 12px 右边距 + gap）。

### 改法
- `apps/client/src/live/live.css`：新增 `.live-mobile-compose .live-wave-slot` 覆盖——**手机端槽位改为绝对定位叠放，不参与 flex 布局**（`position: absolute; right: 0; bottom: calc(100% + 6px)`），声波浮在麦克风按钮上方、收起成一枚带底色的胶囊；`.live-mobile-compose .live-wave` 同步改为胶囊底色 + 居中。**空闲 / 录音时输入栏布局完全一致**，麦克风按钮贴右、输入框宽度恢复。
- **桌面端未改**：`.live-wave-slot` 的固定槽位（76px）与 `.live-wave` 原样式保留，freeze-fix4 行为不变。
- 未改 `.tsx` 结构、未改视觉设计 token。

### 测试
- `e2e/mobile-mic-hints.spec.ts` 新增用例 `④ 输入栏空闲时不预留声波槽位，麦克风按钮贴右且按住不位移`（iphone-13）：
  - 空闲时麦克风按钮右边缘距视口右边缘 ≤ 24px；
  - 按住期间按钮 x 偏移 < 4px；
  - 松开后按钮 x 偏移 < 1px、输入框宽度变化 < 1px。
- **修复前**：④ 失败（`Expected: <= 24, Received: 96`），符合预期。
- **修复后**：
  - `E2E_SERVER_PORT=8897 E2E_CLIENT_PORT=5284 pnpm exec playwright test e2e/mobile-mic-hints.spec.ts --project=iphone-13` → **4 passed**（①–④）。
  - `E2E_SERVER_PORT=8897 E2E_CLIENT_PORT=5284 pnpm exec playwright test e2e/ptt-hold.spec.ts --project=desktop` → **1 passed**（桌面按住说话不受影响）。
  - `pnpm test` → **1091 passed（112 文件）**。
  - `pnpm typecheck` → 全部通过。

### 未做
- 未 commit；未打开图片；未动桌面端声波槽位行为。
