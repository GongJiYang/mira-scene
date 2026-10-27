# S6l-fix1 任务说明：第二次换背景必失败 + 刷新恢复 + 反应音音色 + 声音叠加

> 来源：用户 2026-10-28 实测反馈「生成的背景和聊天记录一刷新就没了」。Claude 已核实原因。执行者：Command Code（deepseek-v4-flash）。在合并了 S6l 的 main 上做。
> 关卡 1–5 结论见末尾（小修，Claude 决定）。

## 铁律
冲突停下写进报告；Key 只从 `.env` 读取、不得打印；不准 commit；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片；长命令显式传大 timeout，同一命令超时两次就停下写进报告；测试里不发真实网络请求。先写会失败的测试，再改代码。不改任何台词和样式。

## 现状（已核实）
- 刷新后客户端用 `sessionStorage` 的 `mira.sessionId` 发 `hello.resumeSessionId`，服务端 `session.ts` 能找回同一个会话（`session_resumed`）。
- 但服务端回的 `session` 消息只有 `{ snapshot: session.scene }`；会话里其实还留着：生成背景 `session.sceneJob.lastReadyLabel / lastReadyUrls`（图片文件仍在 `var/generated/`）、对话 `session.history`。
- 客户端背景与弹幕列表只在内存里，所以刷新后回到默认背景、弹幕清空。

## §0 第二次换背景必失败（先修，最高优先）
- 现象（用户实测，2026-10-28 04:13 / 04:17）：第一次换背景成功后，之后每次换背景都失败，服务端日志只有 `scene_prompt_version`，没有任何失败记录。
- 根因（Claude 已核实）：S6c-fix1 §7 让参考图 = 当前背景。换成功后当前背景是生成图，URL 形如 `/generated/scene-<id>-desktop.png`，文件实际在 `var/generated/`（`GENERATED_DIR`，见 `adapters/media/imageGen.ts` 的数据目录解析）；但 `session.ts` 用 `resolveClientAssetPath()`（`characters/pack.ts`）把它映射成 `apps/client/public/generated/...`，该文件不存在 → 生图上传参考图失败。
- 修法：参考图路径解析区分来源——`/generated/` 开头的 URL 解析到生成目录（**复用 imageGen.ts 里已有的生成目录解析函数**，必要时导出，不要另写一份），其余仍走 `resolveClientAssetPath`。写成纯函数 `resolveReferencePath(url, dirs)` 并单测。
- 可观测：换背景任务失败 / 被拒时，`session.ts` 必须 `logTurn("scene_failed" | "scene_rejected", { error | note })`（不含 Key、不含完整提示词），观测页错误统计能看到。
- 测试：集成测试——第一次换背景成功后，第二次任务的参考图路径指向 `GENERATED_DIR` 下真实存在的文件且任务成功（用假生图端口，断言收到的 `reference.path` 存在）；失败时日志有 `scene_failed` 及原因。

## §1 协议与服务端
- `session` 消息 payload 增加（`packages/protocol/src/messages.ts`，zod 同步）：
  - `background: { label: string; urls: <与 scene_status ready 相同的 urls 结构> } | null` —— 来自 `sceneJob.lastReadyLabel/lastReadyUrls`，没换过背景为 null。
  - `transcript: Array<{ role: "user" | "assistant"; text: string }>` —— 来自 `session.history`，最多最近 40 条；assistant 的多句按原样（换行分隔）保留。
- 新会话（非恢复）发 `background: null, transcript: []`。字段对旧客户端是新增可选，不破坏现有解析。

## §2 客户端
- 收到带 `background` 的 `session` 消息：直接切到该背景（走 scene_status ready 的同一套应用逻辑，但**不播「生成中」状态和切换动画**，直接显示）。
- 收到 `transcript`：把 `role:"user"` 的条目按顺序恢复进弹幕列表（显示为「你」发的弹幕，样式与平时一致），不重复添加；assistant 条目不进弹幕区（字幕不恢复，避免刷新后突然出现旧字幕）。
- 剧情进度（S6l 的顶栏标题与进度点）本来就由 `snapshot` 恢复，确认刷新后仍正确。

## §3 测试
- 服务端集成：换背景成功 → 同 sessionId 重新 hello → `session` 消息带 `background`（label/urls 与 ready 时一致）和 `transcript`；新会话为 null / []；transcript 超过 40 条时只保留最近 40 条。
- 客户端单测：reducer / store 收到带 background、transcript 的 session 消息后，背景 url 正确、弹幕里有用户的历史消息且不重复。
- e2e（Mock）：发一条消息 → 触发换背景并等到成功 → `page.reload()` → 断言背景仍是生成图、用户刚发的弹幕仍在、剧情进度不变。
- `pnpm test`、`pnpm typecheck` 全绿；`PROVIDER_MODE=mock pnpm smoke` 通过。

## §5 思考时的反应音是「男声」（用户实测：说话前偶尔冒出很短的陌生音色）
- 根因（Claude 已核实）：`apps/client/public/sfx/react-{hmm,mm,ah}.mp3` 是 S3 时 `apps/server/scripts/make-sfx.ts` 用 `FISH_VOICE_ID` 合成的；本机 `.env` 里 `FISH_VOICE_ID` 为空（只有 `FISH_VOICE_ID_YUNA`），所以没传 `reference_id`，用了 Fish 默认音色。反应音全局共用、不分角色（`core/reactionSfx.ts` 的 `REACTION_SFX_URLS`）。
- 修法：
  - 反应音按角色：`apps/client/public/characters/<id>/sfx/react-*.mp3`，客户端按当前角色取 URL；某角色没有反应音时**不播**（不回退到全局文件）。删除旧的全局 `public/sfx/react-*.mp3` 及其引用。
  - `make-sfx.ts` 加 `--character <id>`，音色用该角色的 `FISH_VOICE_ID_<ID>`（与会话层 `resolveVoiceId` 同一规则，复用而不是重写）；音色变量为空时**报错退出**，不得不传 `reference_id`。
  - 运行一次 `pnpm --filter @mira/server exec tsx scripts/make-sfx.ts --character yuna` 重新合成（真实 Fish 调用，只在这里）；文本保持原来三条不变。Fish 报错就停下写报告。
- 测试：单测——反应音 URL 随角色变化、无反应音的角色 `arm()` 不播放；脚本在音色变量为空时退出码非 0（用注入 env 测，不发网络）。

## §6 预录声音叠加（用户实测：Mock 预录声音有时叠在一起）
- 根因（Claude 已核实）：客户端有两条互不相干的播放通道。主通道 `core/audio.ts` 播 beat 音频，受打断控制；旁路 `core/fallback.ts` 的 `playLocalAudio()` 每次**新建一个 AudioContext** 直接播放，断线兜底（`installOfflineFallback`）和 S6c-fix1 新加的换背景兜底（`live/scene/sceneFallback.ts`）都走它——打断停不掉、下一句开始也不让位，于是叠加。
- 修法：所有本地音频（兜底语音、反应音）都经主通道播放，复用 `audio.ts` 已有的 AudioContext 和播放/停止逻辑；**同一时刻只有一段声音**：新的 beat 音频开始时停掉正在播的兜底/反应音，兜底语音在 beat 播放期间排队（沿用 sceneFallback 的排队规则）；打断执行器（`core/interrupt.ts`）的「停音频」一步同时停掉它们。删除 `playLocalAudio` 里的 `new AudioContext()`。
- 可观测：两段音频同时处于播放状态时 `pushEvent("audio_overlap")`（调试缓冲），便于以后复查。
- 测试：单测——兜底语音播放中 beat 开始 → 兜底被停；打断 → 所有音频停；属性测试（沿用打断矩阵的 fast-check 写法）：任意时刻处于播放状态的音源 ≤ 1。

## §4 报告 `docs/tasks/s6l-fix1-report.md`

## 关卡 1–5 结论（Claude 决定）
1. **YAGNI**：只恢复背景与用户弹幕；不做持久化存储（服务端重启后会话本来就会丢，README 已列为已知限制），不恢复字幕。
2. **端口/适配器**：不碰外部服务；只扩 `session` 消息。
3. **函数式核心**：服务端从 session 取 background/transcript 写成纯函数 `resumePayload(session)`；客户端恢复逻辑走 reducer。
4. **契约式设计**：服务端是唯一事实来源；新字段可选，缺省按 null / [] 处理；transcript 上限 40。
5. **测试奖杯**：服务端集成 + reducer 单测 + 1 条刷新 e2e。
