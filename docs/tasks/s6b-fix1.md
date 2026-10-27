# S6b-fix1：Claude 审查发现的 6 个问题

> s6b.md 的铁律全部有效（冲突停下报告；台词原样；Key 只从 .env 读、不打印；不准 commit；不做余额降级）。
> **工具注意**：不要用读文件工具打开任何图片；shell 工具默认 30 秒超时，跑测试/e2e 等长命令时必须显式传较大的 timeout（例如 600000），同一条命令超时两次就停下写进报告，不要无限重试。
> 主目录 `/Users/gjy/mira-scene`。另一个 worktree 的 e2e 可能占用 8987/5373，本目录 e2e 用默认端口。

## 1.【严重】TTS 音色没有按角色区分
- 现状：`index.ts` 里 Fish TTS 用全局 `providers.fish.voiceId`；角色包的 `voice.fishVoiceIdEnv` 没被使用 → 真实模式下忧奈用夏凛的声音。
- 改法：TTS 的音色按会话的角色包决定。`TtsOptions` 增加 `voiceId`（或等价设计），会话层从 `session.pack` 取；启动时按每个角色包的 `fishVoiceIdEnv` 读环境变量，真实模式下缺失 → 启动报错（s6b §1 原要求）。Mock TTS 同样按角色取（见第 2 条）。
- 测试：集成测试——rin 会话和 yuna 会话分别发一轮，断言 TTS 收到各自的 voiceId。

## 2.【严重】Mock 语音按「台词 + 情绪」取键，两个角色会撞
- 现状：两个角色的 Mock 录音都放 `assets/voice/clips/<key>.mp3`，key 只由台词 + 情绪决定；同一句台词同一情绪会互相覆盖，而两人声音不同。
- 改法：按角色分目录：`assets/voice/<characterId>/clips/<key>.mp3`（`voiceKey` 规则不变），Mock TTS 按会话角色查对应目录；`voices:list` 重新生成 `characters/<id>/voice-pack.json` 和 `docs/voice-pack.md`（文件名列写完整相对路径）。旧的 `assets/voice/manifest.json`（当前 0 条）按新结构迁移或拆分。
- 测试：两个角色有同一句台词 + 同一情绪时，各自取到各自的文件。

## 3.【严重】切频道时旧会话的消息会串到新频道
- 现状：切频道复用同一条 WebSocket。服务端收到新 hello 时只给**新**会话绑定 `send`，旧会话仍持有同一个 `send`：它的后台媒体任务（D27：打断不取消生图）完成后会把 `media_ready` 发进新频道；客户端收到任何消息都会 `storeSessionId(message.sessionId)`，迟到的旧消息会把客户端「拉回」旧会话。
- 改法：
  - 服务端：同一连接上建立新会话时，**解绑**该连接上的其他会话：`controller.abort()`、`mediaController.abort()`、`send = null`（会话本身留给空闲回收）。纯函数或小模块实现「连接 → 当前会话」映射，便于单测。
  - 客户端：切频道后只接受新会话的消息——`switchCharacter` 记一个「等待新会话」状态，收到新 hello 的 `session` 消息后锁定 sessionId；之后 `sessionId` 不一致的消息一律丢弃（记一条调试事件），不再 `storeSessionId`。
- 测试：服务端集成测试——rin 会话发起后台媒体 → 同连接切到 yuna → 媒体完成后 yuna 连接上**收不到** rin 的 `media_ready`；客户端单测——旧 sessionId 的消息被丢弃且不覆盖存储。

## 4.【原则】生图没有用到对话内容
- 现状：`MediaPort.preset(media, signal)` 拿不到对话，`buildImagePrompt(pack, [])` 永远是空历史 → 不满足题目「根据当前对话动态生成」。
- 改法：`MediaPort` 增加上下文参数（如 `preset(media, ctx: { pack, history }, signal)`），会话层发起媒体任务时传入当前角色包和最近对话；`buildImagePrompt` 用最近 3 轮（用户 + 角色台词，各截断 80 字）。`presetMedia` 忽略 ctx。另外把外层 `signal` 也接到 `fetch` 上（会话解绑/关闭时能中止生图请求），内部超时仍是 60 秒。
- 测试：`buildImagePrompt` 单测（有历史时包含最近 3 轮、超长截断、模板占位被替换）；集成测试断言 imageGen 收到的 prompt 含本轮之前的对话。

## 5.【原则】生成的图片写进了客户端源码目录
- 现状：`imageGen` 写入 `apps/client/public/generated/`：只在开发模式可用；生产构建后的前端不会包含运行时生成的文件；还可能被误提交（未进 `.gitignore`）。
- 改法：写到服务端自己的数据目录（例如仓库根 `var/generated/`，加进 `.gitignore`，可用 `GENERATED_DIR` 覆盖），由服务端 HTTP 提供 `GET /generated/<file>`：文件名只允许 `^[a-z0-9_-]+\.png$`，其它一律 404（防路径穿越）；Vite 开发代理加 `/generated` → 服务端。
- 测试：路由的文件名校验纯函数单测（含 fast-check：任意字符串含 `/`、`..`、`\` 都被拒）；集成测试：生成后 GET 能取到。

## 6.【测试有效性】直播间 e2e 没有验证人物真的画出来
- 现状：`e2e/out/live-switch-desktop.png` 里忧奈频道是全黑的（截图早于模型加载），但用例通过——断言没有检查画面内容。Claude 手动等 10 秒后确认是正常渲染的。
- 改法：`e2e/live.spec.ts` 切到忧奈后，等待（最多 20 秒）Live2D 画布出现非透明像素（`readPixels` 或 canvas `toDataURL` 采样）且背景图 `complete`，再截图。桌面用点击频道头像，手机用**滑动**切换。夏凛频道同样断言舞台图层已加载。
- 顺带查一个现象：手机 390×844 的夏凛频道，画面下方字幕区后面又出现了一截她的身体（像图层重复或没有铺满），请定位并修正，修正后截图对比。

## 验收
`pnpm test`、`pnpm typecheck`、`pnpm smoke`、`pnpm e2e` 全部通过；重新生成 `docs/voice-pack.md`。报告追加到 `docs/tasks/s6b-report.md` 末尾「fix1」一节，逐条写改法和测试。
