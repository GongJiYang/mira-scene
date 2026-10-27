# S4 报告：舞台（背景 / 雨 / 镜头 / 前景 / 拍立得显影 / 角色占位）+ 主动开口

基线：`8f3e964`。未 commit。未改 `docs/architecture/`。未碰 `tools/`（`tools/live2d-pipeline/l2dp/step6.py`、`config.refpack.json`、`overrides.py` 是用户原有改动，保持原样）。

## 0. 验收结果

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 4 个 workspace 全部 Done |
| `pnpm test` | ✅ 40 个文件 / **392 tests passed**（基线 336，新增 56） |
| `pnpm smoke` | ✅ `SMOKE OK` |
| `pnpm e2e` | ✅ **5 passed / 3 skipped**（连跑 2 次稳定）；截图见 §3 |

首次运行 `pnpm e2e` 前需要：`npx playwright install chromium`（已写进 `playwright.config.ts` 注释与本节）。

测试策略（架构关卡 §5）：4 个纯函数写单测；集成测试验证「视图模型变化 → `Layer[]` 变化」；Playwright 只做少量端到端断言 + 截图，**不做像素级比对**。

## 1. 改动的文件

### 协议包（`packages/protocol/src/`，只新增）
- `beat.ts`：`mediaSchema` 新增可选 `storyEventId`。
- `messages.ts`：新增客户端消息 `nudge`（`nudgePayloadSchema`，turnId 走统一信封）。

### 服务端（`apps/server/src/`）
- `ports.ts`：新增 `MediaPort`（`preset(media, signal) → {url, status}`）；`LLMContext` 新增可选 `nudge`。
- `adapters/media/presetMedia.ts`（新增）：预置照片适配器，默认 2.5s 后就绪，返回 `/stage/photos/<id>.png`；支持 AbortSignal。
- `session.ts`：
  - 一轮输入规范化为 `TurnInput`（text / audio / nudge）；`handleInput` → `handleTurnInput`。
  - `nudge` 按一次新输入处理：`user_text` 固定为「（客人安静地坐着，没有说话）」、`nudge` 标记透传给提示词、**禁止本轮推进剧情**（`advancedThisTurn = true`，因此不计入 trust）、**不计入会话/每日限额**。
  - 带 media 的 beat 追加 `storyEventId = <sessionId>:<turn>:<seq>`；投递 `media_ready` 的后台任务**独立于轮次取消**（打断后仍送达），按 `storyEventId` 去重，`dispose()` 时统一中止。
- `adapters/mock/mockLlm.ts`：`nudge` 时返回一句主动台词（先抿咖啡，再轻声说一句）+ 一个无声动作，不推进剧情。
- `prompts/renderPrompt.ts`：`nudge` 时给动态后缀 `scene_notes` 追加沉默提示。
- `config.ts` / `index.ts`：新增 `MEDIA_PRESET_DELAY_MS`（默认 2500）并注入 `createPresetMedia`。

### 客户端（`apps/client/src/`）
- `stage/`（新增，纯函数 + 外壳）：
  - `layers.ts`：`composeStage(vm) → StageLayer[]`（`{id, src, opacity, transform, z}`）+ `backgroundForKey` / `orientationFor` / `characterTransform` / URL 构造。
  - `rain.ts`：`rainParams(fx, tMs, reducedMotion?) → {count, speed, alpha}`。
  - `camera.ts`：`cameraTransform(camera, progress) → {scale, tx, ty}`。
  - `develop.ts`：`developProgress(elapsedMs) → 0..1`。
  - `RainCanvas.tsx`：1 个 canvas 的斜线雨（rAF 驱动，参数全部来自 `rainParams`）。
  - `stage.css`：2:3 舞台、层级、呼吸动画、桌面/相纸/显影的样式（占位级）。
- `view/Stage.tsx`（新增）：DOM 舞台外壳（背景 1.2s 交叉淡入淡出、雨 canvas、角色分层、前景桌面、暖光、拍立得 developing→shown→居中→桌角、字幕与输入占位）。
- `view/useStageViewModel.ts`：`StageViewModel` 新增 `reports`（唯一允许的回调通道）；已有字段与方法未改。
- `state/nudge.ts`（新增）：`nudgeLimit` 纯函数（30s 间隔、连续 3 次上限、用户开口重置）。
- `state/storyMedia.ts`：C 新增动作 `IMAGE_FAILED`（见 §4 说明）。
- `state/reducer.ts` / `state/types.ts`：A 新增 `NUDGE` 动作（复用 `beginTurn`，已有转移规则未改）。
- `core/controller.ts`：`recordNudge`（条件 + 频率限制后发送）、`reports.mediaLoadFailed`、用户开口时重置 nudge 计数。
- `core/connection.ts`：新增 `sendNudge`；收到带 media 的 beat 时登记 C 的显影请求。
- `core/storyMediaLink.ts`：新增 `handleMediaRequest`。
- `App.tsx` 渲染 `Stage`；删除已弃用的 `PlaceholderStage.tsx`。
- `vite.config.ts`：端口可被 `MIRA_CLIENT_PORT` / `MIRA_SERVER_PORT` 覆盖（供 e2e 用独立端口）。

### 素材接入（§1）
- `apps/client/public/stage/assets → ../../../../assets`、`apps/client/public/stage/photos → ../../../../assets/raw`：**两个符号链接**，不复制大文件。
- 已验证：`pnpm dev` 直接可访问；`vite build` 产物包含素材（`dist/stage/...` 实测存在）。

### 测试与工程配置
- 新增客户端单测：`stage.test.ts`、`stageIntegration.test.ts`、`rain.test.ts`、`camera.test.ts`、`develop.test.ts`、`nudge.test.ts`、`storyMediaImageFailed.test.ts`。
- 新增服务端测试：`media.test.ts`、`nudge.test.ts`。
- `e2e/stage.spec.ts`、`playwright.config.ts`（新增）；根 `package.json` 增加 `"e2e": "playwright test"` 与 `@playwright/test`（dev 依赖）。
- `vitest.config.ts`（新增）：把 `e2e/**` 排除出 Vitest 收集范围。
- `.gitignore`：忽略 `e2e/out/`、`e2e/.artifacts/`、`test-results/`、`playwright-report/`。

## 2. 契约与关键实现点

- **端口/适配器**：客户端定义 `StageRenderer` 的输入契约（`StageVm`，即视图模型快照：phase / visual / 表演帧 / media / C 状态），本批实现 DOM+CSS+1 canvas；换 Live2D 只需新增一种实现。服务端 `MediaPort` 本批只有 `preset`。
- **渲染层不得 dispatch**：`Stage.tsx` 只通过 `useStageViewModel()` 读状态、调 `intents`；唯一例外是图片加载失败回调，经 `reports.mediaLoadFailed → controller → C`。
- **素材失败不卡状态机**：背景兜底色 `#1b2233`；照片加载失败 → C 换另一张预置照片（`photo_rain_street`）；角色贴片失败只显示 master（浏览器行为，无额外状态）。

## 3. 截图列表（`e2e/out/`，iPhone 13 与桌面各一张；截图为对应用例中的阶段）

| 文件 | 内容 |
|---|---|
| `1-idle-iphone-13.png` / `1-idle-desktop.png` | 首屏待机（背景 + 雨 + 角色 + 前景桌面 + 字幕/输入占位） |
| `1-listening-iphone-13.png` / `1-listening-desktop.png` | 倾听（前倾 1.02、上移 4px） |
| `1-speaking-iphone-13.png` / `1-speaking-desktop.png` | 说话（字幕 + 口型/表情分层） |
| `2-speaking.png` | 文字输入后进入 speaking |
| `3-before-reveal.png` | 进入 reveal 前（probe） |
| `3-developing.png` | 拍立得 developing（空白相纸） |
| `3-shown.png` | 显影完成：推镜到 1.18、照片浮在中央（`photo_letters`） |
| `4-speaking.png` / `4-interrupted.png` | 打断前后：字幕从有到空（Q1） |

## 4. 与说明不一致的地方 / 发现的歧义

1. **带 media 的 beat：C 的 REQUEST 时机**（最重要）。
   说明 §6 写「带 media 的 beat **开始播放时**向 C 发 REQUEST」。实测 Mock 剧本把 `advance:"reveal"` 挂在**最后一个 beat**（现有 `mockLlm.test` 已把这点固定下来：`composeBeats(...).at(-1).advance`），于是 media 落在该轮**最后一个无声 beat**上；它的「开始播放」比 beat**产出**晚约 5s，而服务端的 `media_ready` 是产出后 2.5s 发出 —— 于是 `ready` 先于 `REQUEST` 到达，而 C 的既有规则会忽略「非 none/shown 状态」的 REQUEST，`developing` 永远观察不到（这也让验收用例 3 无法成立）。
   处理：把 REQUEST 提前到**带 media 的 beat 一到达**时登记（`connection.ts`），保证 `developing → shown` 的既定顺序。**这是对说明的有意偏离**，原因如上；若后续把 media 固定挂在该轮第一个 beat，可改回「开始播放时」。
2. **`storyEventId` 的生成位置**。说明写「由导演层生成」，但导演层是纯函数、拿不到 sessionId / turnId / seq。实现放在 `session.ts` 分配 `seq` 的那一处（唯一的「导演流水线」环节），格式与说明一致。
3. **C 的图片失败兜底需要新增动作**。说明要求「照片加载失败 → C 转到 fallback」，但 C 既有的去重规则会把「已经 shown 的同一 storyEventId」的 `FALLBACK` 直接忽略（`storyMedia.test.ts` 明确断言了这一点）。为不改动既有转移规则、也不改既有测试，新增了动作 `IMAGE_FAILED`（只在 `shown` 且 id 匹配时把媒体换成另一张预置照片，状态保持 `shown`）。既有转移规则与既有用例全部保持原样。
4. **`warm_glow` 的背景归属**。说明只写「warm_glow 叠暖光」，没说背景切到哪一态；而 fx 是「取最新值」的单一字段，ending 的 `warm_glow` 会覆盖 `lights_dim`。实现取 `warm_glow → closing`（灯暗 + 暖光），与 D32「ending 灯暗下来」一致。
5. **`fx` 为 null（会话尚未出 beat）**：说明写「雨的强度 1.0（会话开始时）」。实现把 `null` 按暴雨处理（首屏就有雨），`warm_glow` 视为雨停。
6. **舞台比例与素材朝向**：说明要求舞台恒为 2:3，同时又要求「横屏用 `_h` 素材」。实现：舞台恒 2:3；`_v`/`_h` 按**视口**宽高比选择，横屏时 `_h`（3:2）以 `cover` 裁切进 2:3 舞台。
7. **`MediaPort` 的注入是可选参数**：为不修改既有测试（`session.test.ts` / `faults.test.ts` / `integration.test.ts` 直接构造 `createSessionManager`），`SessionDeps.media` 为可选，缺省用「立即就绪」的兜底实现，真实运行由 `index.ts` 注入预置适配器。
8. **`Connection.sendNudge` 为可选方法**：同上，避免改动 `controller.test.ts` 里的假连接。
9. **端到端端口**：验收机器上 5173 与 8787 **已被其它进程占用**（非本任务产生，未去动它们）。`pnpm e2e` 通过 `PORT=8887 MIRA_CLIENT_PORT=5273 MIRA_SERVER_PORT=8887` 使用独立端口，并强制 `PROVIDER_MODE=mock`。若你的 5273/8887 也被占用，需要改 `playwright.config.ts` 的这两个端口。
10. **字幕/输入在矮屏需要滚动**：舞台按说明「手机上宽度占满」，iPhone 13（390×664）下舞台占 555px，字幕与输入落到首屏之下（竖向滚动，无横向滚动）。本批只要结构和占位，正式 UI 由你另行设计。

## 5. 安全与进程

- 全程未打印、未写入任何 Key；`PROVIDER_MODE=mock` 下不读取凭据，测试与 e2e 均不发真实网络请求。
- 未 commit。
- 未触碰 `tools/` 与用户已在改的文件。
- e2e 结束后 dev server 已随 Playwright 关闭，5273 / 8887 已释放（已用 `lsof` 复核）。
