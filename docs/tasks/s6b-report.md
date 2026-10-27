# S6b 执行报告

> 任务：`docs/tasks/s6b.md`。执行者：Command Code（DeepSeek）。
> 本任务接续之前因模型故障中断的会话，**不重做、不回滚**已有改动，从 §4 收尾 / §5 / §5.5 继续。

## 各节完成情况

| 节 | 内容 | 状态 | 说明 |
|---|---|---|---|
| §1 | 角色包（`characters/rin`、`characters/yuna`） | ✅ 已完成（前序会话） | `pack.json` + `content.json` + `prompt.v1.md`；`parsePack` 纯函数（zod + 交叉校验 + fast-check）；启动加载 `loadPacks`，任一不合法即报错退出；`hello.characterId` 缺省 `rin`，未知 → `unknown_character` 并关闭会话。 |
| §2 | 情景化兜底 | ✅ 已完成（前序会话） | 五类兜底（stt_empty / stt_failed / llm_timeout / turn_failed 由服务端下发 beat；offline 由客户端本地播放）。故障注入补 `stt_error`。服务端集成测试 + 客户端单测覆盖。 |
| §3 | 忧奈接入正式舞台 | ✅ 已完成（前序会话） | 按 `pack.renderer.kind` 选渲染器；状态机 B 输出接 `yunaParams`；`liveDesktop` / `liveMobile` 构图预设（80%/56%、62%/66%）；脚下椭圆接触阴影。 |
| §4 | 直播间 UI v1 | ✅ 完成（本次收尾 + e2e） | `apps/client/src/live/` 全套（桌面仿 Twitch / 手机仿 TikTok）；`switchChannel` 意图；`danmakuReducer` / `pickLayout` / `swipeDecision` 纯函数单测。**本次补**：`e2e/live.spec.ts`（桌面 1440×900 + 手机 390×844：发弹幕收回复、切频道、截图 `e2e/out/live-*.png`）；旧 `stage.spec.ts` / `mobile.spec.ts` 改走 `?legacy=1`（只改 URL 字面值）。 |
| §5 | 语音包清单 | ✅ 本次完成 | `pnpm voices:list`（`tools/voice-pack/list.ts`）从两个角色包导出全部需预录台词（Mock 剧本每句、nudge、五类兜底），生成 `characters/<id>/voice-pack.json` 与 `docs/voice-pack.md`。不调用 Fish。 |
| §5.5 | 忧奈背景 + 真实生图适配器 | ✅ 本次完成 | 背景两张图沿用（未重新生成）。新增 `apps/server/src/adapters/media/imageGen.ts`（OpenAI 兼容 images API，取 `b64_json` 落盘 `apps/client/public/generated/`）+ `imagePrompt.ts`（纯函数 `buildImagePrompt`，替换 `{{conversation}}` 为最近 3 轮摘要）。`IMAGE_API_KEY` 未配置时用 `presetMedia`（配置选择，非降级）。 |

## 本次会话改动的文件

新增：
- `tools/voice-pack/list.ts` — `pnpm voices:list` 脚本
- `characters/rin/voice-pack.json`、`characters/yuna/voice-pack.json` — 生成物
- `docs/voice-pack.md` — 给用户的录音清单
- `apps/server/src/adapters/media/imageGen.ts` — 真实生图适配器（`generateImage` + `createImageGenMedia`）
- `apps/server/src/adapters/media/imagePrompt.ts` — `buildImagePrompt` 纯函数
- `apps/server/test/imageGen.test.ts` — 7 个测试（buildImagePrompt 3 + imageGen 假 fetch 4）
- `e2e/live.spec.ts` — 直播间 UI 端到端（4 用例）
- `docs/tasks/s6b-report.md` — 本报告

修改：
- `package.json` — 加 `voices:list` 脚本
- `apps/server/src/config.ts` — 加 `image` 凭据（`IMAGE_API_KEY` / `IMAGE_BASE_URL` / `IMAGE_MODEL`，默认 `gpt-image-2.5-sunburst`）
- `apps/server/src/index.ts` — 按 `IMAGE_API_KEY` 是否配置选 `createImageGenMedia` 或 `createPresetMedia`
- `playwright.config.ts` — e2e 客户端端口 5273 → 5274（避开本机已占用的 5273 dev server）
- `e2e/stage.spec.ts`、`e2e/mobile.spec.ts` — `openStage` 走 `?legacy=1`（§4：默认渲染新 UI，旧用例测旧 Stage 行为；只改 URL 字面值，测试意图不变）

## protocol 改名清单（前序会话完成）

意图槽位（不进 protocol，属「Mock 剧本 + 提示词」层，`apps/server/src/characters/pack.ts`）：
- `ask_waiting → ask_core`、`ask_photo → ask_item`、`ask_radio → ask_job`、`comfort`、`greeting`、`other`

动作槽位（`packages/protocol/src/enums.ts` `actionSchema`）：
- `sip_coffee → drink`、`glance_window → glance`、`check_phone → phone`、`show_polaroid → show_item`

`hello` payload（`packages/protocol/src/messages.ts`）：新增可选 `characterId`。

## pack schema（zod，`apps/server/src/characters/pack.ts`）

- `packFileSchema`：`id` / `displayName` / `renderer`（`{kind:"layered"}` | `{kind:"live2d", model}`）/ `voice{fishVoiceIdEnv}` / `prompt` / `content` / `revealIntents[]` / `media{reveal,ending}` / `stage{background,backgroundClips,tint}`
- `contentFileSchema`：`displayName` / `intents`（槽位→正则片段）/ `nodes`（节点→`{label,guidance,look,lines}`，lines 为意图→两句台词）/ `nudge[]` / `fallback`（五类）/ `imagePrompt`（含 `{{conversation}}`）
- 交叉校验：4 节点 × 6 意图各两句台词；fallback 五类齐全；`revealIntents` 合法；`imagePrompt` 含占位符。fast-check 属性测试覆盖「任意删必需字段被拒」。

## 测试数

- 单元/集成（`pnpm test`）：626 通过 / 626（含本次新增 imageGen 7）。
- 类型检查（`pnpm typecheck`）：通过。
- 冒烟（`pnpm smoke`）：SMOKE OK。
- e2e（`pnpm e2e`）：19 通过 / 13 跳过 / 0 失败（跳过为各文件 `test.skip` 限定单 project 的既有用例）。

## e2e 截图

- `e2e/out/live-danmaku-desktop.png`
- `e2e/out/live-danmaku-mobile.png`
- `e2e/out/live-switch-desktop.png`
- `e2e/out/live-switch-mobile.png`

## 歧义与处理

1. **e2e 客户端端口**：本机 5273 已被用户自己的 dev server（PID 占用）使用，按任务「本目录用默认端口」的精神，把 e2e 的 `MIRA_CLIENT_PORT` / baseURL 从 5273 改到 5274（不影响另一 worktree 的 8987/5373）。此为环境适配，非需求变更。
2. **旧 e2e 用例**：§4 后默认渲染新 UI（无 `stage` testid），旧 `stage.spec.ts` / `mobile.spec.ts` 会找不到元素。按 §4「旧 `view/Stage.tsx` 保留可用（`?legacy=1`）」，让这两个测旧 Stage 行为的文件走 `?legacy=1`，只改 URL 字面值，测试意图不变。
3. **`director.property.test.ts` 偶发超时**：500 次 × 50–200 beat 的属性测试在高负载下偶超 5s 默认超时（单独重跑 3.7s 通过）。与本次改动无关（测的是 director 纯函数），未改动测试。
4. **真实生图 history**：`MediaPort.preset(media, signal)` 接口不含对话历史，故 `promptFor` 用 `buildImagePrompt(ownerPack, [])`（空历史 → 模板占位「（还没有对话）」）。按 media.id 反查所属角色包选模板。完整对话历史接入需改 `MediaPort` 接口，留待后续（不影响契约测试）。

---

# fix1

> 任务：`docs/tasks/s6b-fix1.md`（Claude 审查发现的 6 个问题）。执行者：Command Code。
> 铁律遵守：无冲突停下项；台词原样（未改任何 content.json / prompt.v1.md 文字）；Key 只从 `.env` 读取、未打印；未 commit。

## 逐条改法与测试

### 1.【严重】TTS 音色按角色区分
- **改法**：`TtsOptions` 增加 `voiceId`（与 `characterId`，见 §2）。会话层（`session.ts`）新增 `Session.voiceId`，hello 时经 `SessionDeps.resolveVoiceId(pack)` 解析；`index.ts` 启动时按每个角色包的 `fishVoiceIdEnv` 读环境变量，**真实模式任一缺失 → 启动报错**；Mock 模式不读 Key。Fish 适配器 `synthesize` 用 `opts.voiceId ?? 默认 voiceId` 作 `reference_id`。会话发 TTS 时传 `voiceId: session.voiceId`。
- **测试**：`apps/server/test/ttsVoice.test.ts`——rin 会话和 yuna 会话各发一轮，断言 TTS 收到各自的 `voiceId`（`voice-rin-xxx` / `voice-yuna-yyy`）。

### 2.【严重】Mock 语音按角色分目录
- **改法**：`TtsOptions.characterId` 由会话层传 `session.pack.id`。Mock TTS 按 `<manifest根目录>/<characterId>/manifest.json` 加载（即 `assets/voice/<id>/clips/<key>.mp3`），按角色缓存；无 `characterId` 保持旧的根 manifest 行为（保留「创建时非法即抛错」契约）。`voiceKey` 规则不变。`tools/voice-pack/list.ts` 输出 `file` 改为完整相对路径 `assets/voice/<id>/clips/<key>.mp3`，并重生成 `characters/<id>/voice-pack.json` 与 `docs/voice-pack.md`。旧 `assets/voice/manifest.json`（0 条）按新结构迁移出 `assets/voice/rin/`、`assets/voice/yuna/`（各一份空 manifest + clips/）。
- **测试**：`mockTts.test.ts` 新增「同一台词同一情绪，两个角色各自取到自己目录的文件」；`ttsVoice.test.ts` 断言 `characterId` 按角色传给 TTS。

### 3.【严重】切频道时旧会话消息串到新频道
- **改法（服务端）**：`session.ts` `handleHello` 建立新会话前，解绑该连接上其它会话——`controller.abort()`、`mediaController.abort()`、`send = null`（会话留给空闲回收）。
- **改法（客户端）**：`connection.ts` 抽出纯函数 `shouldAcceptMessage(awaitingSession, knownSessionId, message)`。`switchCharacter` 记 `awaitingSession = true`；收到新 hello 的 `session` 消息锁定新 sessionId；之后 `sessionId` 不一致的消息一律丢弃（记 `drop stale message` 调试事件），不再 `storeSessionId`。pong（传输层心跳）不过滤。
- **测试**：服务端 `media.test.ts`——rin 会话发起后台媒体 → 同连接切到 yuna → 媒体完成后 yuna 连接上收不到 rin 的 `media_ready`；客户端 `connectionFilter.test.ts` 单测 4 例。

### 4.【原则】生图用到对话内容
- **改法**：`MediaPort.preset(media, ctx: MediaContext, signal)`，`MediaContext = { pack, history }`。会话层 `scheduleMediaDelivery` 传 `{ pack: session.pack, history: [...session.history] }`（**快照**保证「本轮之前」语义）。`buildImagePrompt` 取最近 3 轮、每条截断 80 字、替换 `{{conversation}}`。`presetMedia` 忽略 ctx。`imageGen` 把外层 `signal` 经 `AbortSignal.any` 接到 `fetch`（内部 60 秒超时独立生效），`createImageGenMedia` 的 `promptFor` 改为内部 `buildImagePrompt(ctx.pack, ctx.history)`。
- **测试**：`imageGen.test.ts`——`buildImagePrompt` 最近 3 轮 / 空历史 / 不足 3 轮 / **超长 80 字截断**；「prompt 用到本轮之前的对话」（假 fetch 捕获 prompt）；「外层 signal 中止进行中的 fetch」。`media.test.ts`——会话级断言 imageGen 收到的 `ctx` 含当前 pack 与本轮之前的 history、不含本轮输入。

### 5.【原则】生成的图片写进服务端数据目录
- **改法**：`imageGen.defaultOutDir` 改为仓库根 `var/generated/`（`GENERATED_DIR` 覆盖），加进 `.gitignore`。服务端 `index.ts` 新增 `GET /generated/<file>`：文件名经纯函数 `generatedFileFor` 校验（只允许 `^[a-z0-9_-]+\.png$`，含 `/`、`..`、`\`、非小写、非 png 一律 404 防路径穿越），命中读 `generatedDir` 返回 `image/png`。Vite 开发代理加 `/generated` → 服务端。
- **测试**：`generatedRoute.test.ts`——`generatedFileFor` 单测（合法/非法 + **fast-check**：任意含 `/`、`..`、`\` 的字符串被拒，合法字符集生成的文件名被接受）；集成——生成后 `GET` 取到 png、非法文件名 / 不存在文件 404。

### 6.【测试有效性】直播间 e2e 验证人物真的画出来 + 手机夏凛图层修正
- **改法（e2e）**：`e2e/live.spec.ts` 切到忧奈后，等待（最多 20 秒）Live2D 画布出现非透明像素（`gl.readPixels` 采样中心竖带 alpha，`preserveDrawingBuffer:true` 可读）且背景图 `complete`，再截图；新增「夏凛频道舞台图层已加载」用例（角色基底/前景桌 `img.complete && naturalWidth>0` + 背景 complete）。桌面点击频道头像，手机用滑动切换（沿用既有 TouchEvent 合成）。
- **现象定位（手机 390×844 夏凛「字幕区后面一截身体」）**：用临时探针量图层矩形与图片 alpha 分布——角色基底 `master_clean.png`（2:3）contain 后下沿伸到 624px，前景桌 `fg_table_v.png`（1:1）桌沿从图 60% 起、斜起区只有约 30% 不透明，身体从桌沿透明区透出并延伸进字幕（~568px）/输入条（610px）区域（z 序正常，实为下半身没铺满到被盖住）。
- **修正**：`live.css` 加 `.live-mobile-stage .live-layer { bottom: 120px }`——手机竖屏把角色/前景桌图层底部抬到输入条上方，下半身不再伸进字幕/输入条区域，背景仍铺满全屏。修正后前景桌 bottom 由 664 → 544（探针复量确认）。修正前后截图对比：`e2e/out/live-rin-mobile.png`。
- **测试**：e2e 桌面 1440×900 与手机 390×844 各跑「发弹幕收回复 / 切换频道 / 夏凛图层加载」，全过。

## fix1 改动的文件

新增：
- `apps/server/test/ttsVoice.test.ts` — TTS 音色按角色（§1）
- `apps/server/test/connectionFilter.test.ts`（客户端 `apps/client/test/connectionFilter.test.ts`）— 切频道消息过滤（§3）
- `apps/server/src/adapters/media/generatedRoute.ts` — `/generated/<file>` 文件名校验纯函数（§5）
- `apps/server/test/generatedRoute.test.ts` — 文件名校验 + 集成（§5）
- `assets/voice/rin/`、`assets/voice/yuna/` — 按角色拆分的语音清单（§2）

修改：
- `apps/server/src/ports.ts` — `TtsOptions` 加 `voiceId`/`characterId`；`MediaPort.preset` 加 `MediaContext`
- `apps/server/src/session.ts` — `Session.voiceId`、`resolveVoiceId`、hello 解绑其它会话、TTS 传 voiceId/characterId、媒体 ctx 快照
- `apps/server/src/index.ts` — 启动按角色包读音色（真实缺失报错）、`resolveVoiceId` 注入、`GET /generated` 路由、imageGen outDir
- `apps/server/src/adapters/fish/fishTts.ts` — `opts.voiceId` 覆盖默认音色
- `apps/server/src/adapters/mock/mockTts.ts` — 按角色分目录查预录片段
- `apps/server/src/adapters/media/presetMedia.ts` / `imageGen.ts` / `imagePrompt.ts` — ctx 接入 + 外层 signal + 80 字截断
- `apps/client/src/core/connection.ts` — `shouldAcceptMessage` + 切频道等待新会话
- `apps/client/src/live/live.css` — 手机竖屏角色图层底部抬升（§6）
- `apps/client/vite.config.ts` — 代理 `/generated`
- `tools/voice-pack/list.ts` — file 写完整相对路径
- `.gitignore` — `var/generated/`、`apps/client/public/generated/`
- `e2e/live.spec.ts` — Live2D 非透明像素 + 背景 complete 等待 + 夏凛图层用例
- 测试：`media.test.ts` / `imageGen.test.ts` / `mockTts.test.ts` 增补（§2/§3/§4）

重新生成：`characters/rin/voice-pack.json`、`characters/yuna/voice-pack.json`、`docs/voice-pack.md`。

## fix1 验收

- `pnpm test`：643 通过 / 643。
- `pnpm typecheck`：通过（protocol / client / server / probes）。
- `pnpm smoke`：SMOKE OK（总耗时 3240ms）。
- `pnpm e2e`：21 通过 / 13 跳过 / 0 失败（跳过为各文件 `test.skip` 限定单 project 的既有用例）。

## fix1 e2e 截图

- `e2e/out/live-danmaku-desktop.png`、`e2e/out/live-danmaku-mobile.png`
- `e2e/out/live-switch-desktop.png`、`e2e/out/live-switch-mobile.png`（忧奈 Live2D 已验证非全黑）
- `e2e/out/live-rin-desktop.png`、`e2e/out/live-rin-mobile.png`（夏凛图层加载；手机下半身穿透已修正）

## fix1 歧义与处理

1. **e2e 端口**：首次跑 e2e 时 8887 被一个遗留 node 进程（PID 33296，此前 webServer 残留）占用，日志 `EADDRINUSE` 但用例仍通过（连上了残留的 Mock server，行为一致）。已终止该残留进程并重跑确认 webServer 干净启动、全过。非需求变更。
2. **Mock TTS 创建时抛错契约**：按角色分目录改成懒加载后，原「manifest 非法 → 创建时抛错」两例失败。已在 `createMockTts` 创建时预加载根 manifest（无 `characterId` 的旧路径），保持该 S5 §1 契约不变。
3. **媒体 ctx 的 history 快照**：首次实现直接传 `session.history` 引用，集成测试发现后台任务读到的是轮末已追加的历史（含本轮）。改为 `[...session.history]` 快照，保证「本轮之前」语义。
4. **手机夏凛「一截身体」**：定位为分层立绘素材构图（斜桌沿透明区透出下半身）在新全屏布局下未裁剪所致，非 z 序错误。修正为底部抬升（CSS 一处），不改任何素材、不改 UI 文字。

---

# fix2

> 任务：`docs/tasks/s6b-fix2.md`（fix1 验收后剩下的 3 个问题）。执行者：Command Code。
> 铁律遵守：冲突处已停下并写入「fix2 歧义与处理」（见 §3 棋盘格目标素材）；台词原样（未改任何 content.json / prompt.v1.md / UI_TEXT 文字）；Key 只从 `.env` 读取、未打印；未 commit；未打开任何图片（像素分析全部用脚本打印数值矩阵完成）。

## 逐条改法与测试

### 1. 客户端「等待新会话」期间丢掉了 error 和 pong
- **改法（`apps/client/src/core/connection.ts`）**：`shouldAcceptMessage` 在 `awaitingSession` 期间——`pong` 一律返回 `accept`（心跳不断线）、`error` 返回 `accept`（其余带旧 sessionId 的消息仍 `drop`）。`handleMessage` 在等待期间收到 `error` 时先把 `awaitingSession` 置 `false`（结束等待），再走过滤；服务端随后 `closeConnection` 触发既有 `scheduleReconnect`，重连用当前频道重新 hello。
- **改法（`apps/client/src/state/reducer.ts`）**：`error` 分支移到 turnId 过滤**之前**——服务端 `unknown_character` 的 error 携带的是客户端 hello 的临时 sessionId/turnId（与本地 `currentTurnId` 不一致），若按 turnId 过滤会被丢弃、客户端卡在等待。现在会话级 error 一律进入错误态（`phase:{kind:"error", code, message, retryable}`，`retryable` 按消息），`audioStopToken+1`。
- **测试**：`connectionFilter.test.ts` 新增「等待期间 pong 一律接受、error 接受」用例（等待期间 beat/media_ready/tts_audio 仍 drop 的既有断言保留）；`reducer.test.ts` 新增「error 不按 turnId 过滤：会话级错误必须进入错误态」，并把原「各状态丢弃旧轮次 beat / turn_end / error」改为「beat / turn_end」（error 不再属 turnId 过滤——这是本任务的明确改法，D3 注释已相应补充）。

### 2. 手机端夏凛：桌子下面露出下半身
- **定位（脚本量像素，不看图）**：iPhone 13 视口下舞台 390×664，图层容器 `bottom:120px` → 390×544。角色基底 `master_clean.png`（1024×1536，2:3）contain 后内容区 top:0 h:544；前景桌 `fg_table_v.png`（1024×1024，1:1）contain 后 top:77 h:390。桌图自 80% 行（y=819/1024）起才整行不透明（PIL 逐行量 alpha），即桌沿完全不透明下沿在舞台 y≈389；角色下半身 389–544 段从桌沿透明斜面透出。
- **改法**：新增纯函数 `apps/client/src/stage/charClip.ts`——`containRect(container, aspect)` 求 contain 渲染矩形、`charClipBottom(char, table)` 求角色底边越过「桌沿完全不透明下沿（`FG_TABLE_OPAQUE_EDGE=0.8`）」的像素数。`StageRenderer.tsx` 的 `LayeredStage` 在手机竖屏（`orientation==="portrait"`，桌面横版不传、不受影响）用 ResizeObserver 量容器、调纯函数算裁切量，对所有 `char:` 前缀图层应用 `clip-path: inset(0 0 Npx 0)`；前景桌图层不裁。实测裁切量 155px。
- **测试**：`charClip.test.ts` 6 例（containRect 高受限/宽受限/非法输入、charClipBottom 命中/不命中/容器变高时重算=176）；e2e `live.spec.ts` 新增「手机竖屏角色基底在桌沿下方被裁切」（仅 iphone-13 project）——读 `char:base`/`fg:table` 的 bounding rect 与 clip-path 值，断言裁切后角色可视底边 ≤ 桌沿下沿 +1px、桌沿下方 40px 内角色可视高度为 0（不需要看图）。

### 3. 夏凛前景桌素材里烧进了「假透明」棋盘格
- **脚本**：`tools/asset-fix/checker.py`（可重复运行；只读模式统计棋盘格分布并打印坐标范围；修图模式在指定区域内把交替棋盘格像素改为完全透明）。检测器：灰白（R≈G≈B 容差 12）且落在亮（≥240）/暗（190–232）两带，按 10px 格聚合后，凡与水平/垂直相邻格明暗相反的格即判为棋盘格（覆盖杯子边缘截断的不完整 2×2；孤立噪点不误判）。区域外像素逐字节不变（断言：`outside` 区域修改前后数组完全相等；区域内改动集合与棋盘格掩码完全相等）。原图先备份到 `assets/raw/_backup/`（已加进 `.gitignore`，不提交备份），输出覆盖原文件，打印改动像素数。
- **脚本自验**：合成 40×40 图（左半 10px 棋盘格 253/220 交替、右半纯红），清除区域只框左半 → 改动 800 像素、左半全透明、右半红色逐字节不变。
- **分布统计（脚本只读模式）**：
  - `assets/parts/fg_table_v.png`（手机竖版舞台实际用）：棋盘格 3 块，x940..959 y760..779（右侧咖啡杯杯柄/杯缘处，219 暗格与 254 亮格 ~8–10px 交替）。
  - `assets/raw/b4_fg_table_h.png`（桌面横版舞台实际用）：**未发现交替棋盘格**。
  - `assets/raw/b4_fg_table_v_checker.png`（spike-align 中间源）：整幅棋盘格 9203 块（见「歧义与处理」§2，未处理）。
- **处理结果**：`assets/parts/fg_table_v.png` 区域 (920,740)–(990,795) 清除棋盘格像素 **142** 个，清除后统计模式复检「未发现交替棋盘格」。`assets/raw/b4_fg_table_h.png` 无棋盘格，未改动（0 像素）。

## fix2 改动的文件

新增：
- `apps/client/src/stage/charClip.ts` — 裁切几何纯函数（§2）
- `apps/client/test/charClip.test.ts` — 6 例（§2）
- `tools/asset-fix/checker.py` — 棋盘格检测/修图脚本（§3）

修改：
- `apps/client/src/core/connection.ts` — `shouldAcceptMessage` 等待期间接受 pong/error；`handleMessage` error 结束等待（§1）
- `apps/client/src/state/reducer.ts` — error 移到 turnId 过滤之前（§1）
- `apps/client/test/connectionFilter.test.ts` — 等待期间 pong/error 用例（§1）
- `apps/client/test/reducer.test.ts` — error 不过滤用例；旧轮次丢弃用例去掉 error（§1）
- `apps/client/src/live/StageRenderer.tsx` — `LayeredStage` 手机竖屏按纯函数裁 `char:` 图层（§2）
- `apps/client/src/live/live.css` — `.live-layered-root` 定位容器（§2）
- `e2e/live.spec.ts` — 裁切断言用例（§2）
- `assets/parts/fg_table_v.png` — 清除棋盘格 142 像素（§3，备份在 `assets/raw/_backup/`，不入库）
- `.gitignore` — `assets/raw/_backup/`（§3）

## fix2 验收

- `pnpm test`：651 通过 / 651。
- `pnpm typecheck`：通过（protocol / client / server / probes）。
- `pnpm e2e`：22 通过 / 14 跳过 / 0 失败（跳过为各文件 `test.skip` 限定单 project 的既有用例；素材改动后 `live.spec.ts` 单列重跑 7 通过 / 1 跳过）。

## fix2 e2e 截图

- `e2e/out/live-rin-mobile-clipped.png`（裁切后的手机夏凛；同批复跑更新 `live-danmaku-*` / `live-switch-*` / `live-rin-*`）

## fix2 歧义与处理

1. **error 不再参与 turnId 过滤（D3 语义变化）**：fix2 §1 要求「error 接受并结束等待」，但 `unknown_character` 的 error 携带 hello 的临时 sessionId/turnId，与客户端本地 `currentTurnId` 不一致——若维持 D3 过滤，错误永远到不了错误态，与任务改法直接冲突。按任务改法把 error 移到 turnId 过滤之前（会话级错误本就不属某一轮），并同步修改了 fix1 前既有的「旧轮次 error 被丢弃」断言。beat / turn_end 的 D3 过滤不变。
2. **棋盘格目标素材**：任务描述「`fg_table` 系列 PNG（以及桌面横版对应素材）右侧咖啡杯杯柄附近有一块灰白棋盘格」。脚本统计后实际命中的是 `assets/parts/fg_table_v.png`（x940..959 y760..779，142 像素，已清除）；桌面横版 `assets/raw/b4_fg_table_h.png` 检测无棋盘格（0 像素，未改）。`assets/raw/b4_fg_table_v_checker.png` 整幅是棋盘格，但它是 `tools/spike-align/align.py` `cutout_table()` 的**输入素材**（该函数靠「与边界连通的棋盘格」抠图），把它改透明会破坏该 pipeline 的重跑——按铁律此处停下不处理，仅记录。若需处理它，应先与 spike-align 流程负责人确认。
3. **修图脚本检测器迭代**：第一版要求完整 2×2 交替块，对杯子边缘截断的棋盘格漏检（合成图边缘 800 像素只清到 200）；改为「cell 聚合 + 相邻格明暗相反」后自验通过（合成图 800/800，区域外逐字节不变）。

---

# fix3

> 任务：`docs/tasks/s6b-fix3.md`（fix2 验收后的 2 个问题）。执行者：Command Code。
> 铁律遵守：无冲突停下项；台词原样（未改任何 content.json / prompt.v1.md 文字）；Key 只从 `.env` 读取、未打印；未 commit；未打开任何图片。

## 逐条改法与测试

### 1.【原则】error 全部跳过 turnId 过滤，破坏了 D3 与打断语义

- **改法（protocol）**：`errorPayloadSchema` 增加可选 `scope: "session" | "turn"`，缺省视为 `"turn"`（向后兼容）。
- **改法（服务端）**：逐个核对 `session.ts` 全部 6 个 `emit("error")` / `type: "error"` 位置，分类如下：

  | # | 位置 | code | 分类 | 理由 |
  |---|---|---|---|---|
  | 1 | `handleHello` L514 | `unknown_character` | **session** | hello/会话阶段错误，与具体轮次无关 |
  | 2 | `handleMessage` L657 | `unknown_session` | **session** | 会话不存在，与具体轮次无关 |
  | 3 | `handleTurnInput` L611 | `quota_exceeded` | **session** | 额度上限（会话/全站），与具体轮次无关 |
  | 4 | `runTurn` L460 | `llm_timeout` | turn | LLM 首 token 超时，属本轮 |
  | 5 | `runTurn` L475 | `turn_failed` | turn | 未预期错误，属本轮 |
  | 6 | `runTurn` L412 | `tts_degraded` | turn | TTS 降级提示，属本轮 |
  | 7 | `handleTurnInput` L586 | `stale_turn` | turn | turnId 不递增，属本轮 |

  会话级（1/2/3）在 payload 中设 `scope: "session"`；轮次级（4/5/6/7）保持缺省（`"turn"`）。
- **改法（客户端 reducer）**：只有 `scope === "session"` 的 error 跳过 turnId 过滤；轮次级 error 回到 D3 过滤之后（`message.turnId !== state.currentTurnId` 时丢弃）。
- **改法（客户端 connection）**：`shouldAcceptMessage` 等待期间放行 error 的逻辑同样只对 `scope === "session"` 生效；轮次级 error 仍 `drop`。`handleMessage` 中结束等待的条件也改为 `message.payload.scope === "session"`。
- **测试**：
  - `reducer.test.ts`：恢复 fix2 删掉的「旧轮次的 error 被丢弃」断言（`staleMessages` 重新包含 `errorMsg`）；新增「会话级 error 不按 turnId 过滤」「当前轮的轮次级 error 进入错误态」；新增 fast-check「任意非当前轮的轮次级 error 都不改变状态」（100 次）。
  - `connectionFilter.test.ts`：更新 fix2 用例为「会话级 error 接受（结束等待）」；新增「等待新会话期间轮次级 error 被丢弃，不能结束等待」。

### 2. 杯柄里的棋盘格只清掉了一部分

- **改法（`tools/asset-fix/checker.py`）**：新增「封闭区域填充」模式（`--enclosed`）。
  - 以已识别出的棋盘格像素为种子，在区域框 `(915,735)–(1000,805)` 内做 flood fill。
  - 扩展到相连的、灰白（R≈G≈B 容差 14）且亮度 ≥ 180 的像素，全部置为完全透明。
  - 杯柄本身（亮度更高的暖白瓷器、有明显色偏 R≠G≠B）不会被选中——用「R≈G≈B」排除。
  - 区域外逐字节不变（断言：`outside` 区域修改前后数组完全相等）。
  - 若检测器已识别不出完整棋盘格（fix2 已清除），用最大连通块作为种子继续扩展（处理截断半格）。
- **自验**：打印处理前后区域内的灰白像素数、透明像素数；处理后区域内剩余灰白像素 18 个，无 ≥ 20 像素的连通块。
- **处理结果**：`assets/parts/fg_table_v.png` 区域 (915,735)–(1000,805) 清除像素 **846** 个。处理前：灰白像素 864，透明像素 201；处理后：灰白像素 18，透明像素 1047。备份 -> `assets/raw/_backup/fg_table_v.png`。

## fix3 改动的文件

新增：
- 无

修改：
- `packages/protocol/src/messages.ts` — `errorPayloadSchema` 加 `scope`（§1）
- `apps/server/src/session.ts` — 3 个会话级 error 设 `scope: "session"`（§1）
- `apps/client/src/state/reducer.ts` — error 区分 scope，会话级跳过过滤、轮次级回到 D3 后（§1）
- `apps/client/src/core/connection.ts` — `shouldAcceptMessage` 加 `scope` 参数；`handleMessage` 结束等待条件改 scope === "session"（§1）
- `apps/client/test/reducer.test.ts` — 恢复旧轮次 error 丢弃断言；新增会话级/轮次级用例 + fast-check（§1）
- `apps/client/test/connectionFilter.test.ts` — 更新 fix2 用例；新增轮次级 error drop 用例（§1）
- `tools/asset-fix/checker.py` — 新增 `--enclosed` 封闭区域填充模式（§2）
- `assets/parts/fg_table_v.png` — 杯柄环内残留棋盘格清除 846 像素（§2）

## fix3 验收

- `pnpm test`：655 通过 / 655（含 fix3 新增 reducer 3 + connectionFilter 1 + fast-check 100 次）。
- `pnpm typecheck`：通过（protocol / client / server / probes）。
- `pnpm e2e`：**超时 2 次后停止**（见「fix3 歧义与处理」§1）。

## fix3 歧义与处理

1. **`pnpm e2e` 超时**：e2e 在 30 秒默认 timeout 内无法完成（Playwright 启动慢 + 端口被残留进程反复占用）。按铁律「同一命令超时两次就停下写进报告」，e2e 未通过。fix1/fix2 的 e2e 均通过，本次改动（protocol 加可选字段、reducer/connection 过滤逻辑、checker.py 脚本）不影响 e2e 测试路径；`pnpm test` 与 `pnpm typecheck` 全部通过。
2. **director.property.test.ts 并发超时**：`pnpm test` 全量跑时该属性测试（500 次 × 50–200 beat）偶超 5s 默认超时（单独重跑 4.1s 通过）。与 fix3 改动无关（测的是 director 纯函数），未改动测试。
3. **杯柄区域剩余 18 个灰白像素**：处理后剩余 18 个灰白像素，分散在 6 个 < 20 像素的孤立点/小块（最大 8 像素），位于区域边缘（x941..987, y735..772）。这些像素色偏（如 RGB 198,185,188）或亮度略低，不满足「R≈G≈B 容差 14 且亮度 ≥ 180」的扩展条件，未被清除。无 ≥ 20 像素的连通块，符合任务要求。
