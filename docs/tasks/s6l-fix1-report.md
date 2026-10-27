# S6l-fix1 执行报告：换背景必失败 / 刷新恢复 / 反应音音色 / 声音叠加

> 执行者：Command Code（deepseek-v4-flash）。基线：S6l 合并后的 main → 分支 `s6l-fix1`。
> 全部修复遵循「先写会失败的测试复现，再改代码让它通过」。**未 commit**。**按用户要求未运行 e2e**（只在冻结点统一跑一次）。
> 铁律遵守：Key 只从 `.env` 读取、未打印；未碰 `tools/live2d-pipeline/**`、`skills/**`；未用读文件工具打开任何图片；测试里未发真实网络请求（唯一真实调用见 §5）；未改任何台词和样式。

## 结果

- `pnpm test`：87 个测试文件、**857 条测试全绿**（基线 820 条 → 新增 37 条）。
- `pnpm typecheck`：全部 workspace 通过。
- `PROVIDER_MODE=mock pnpm smoke`：**SMOKE OK**（7 步全过，总耗时 3228ms）。
- e2e：已写好 `e2e/s6l-fix1.spec.ts`（刷新恢复用例），**未运行**。

## 各条修复与对应测试

### §0 第二次换背景必失败（最高优先）
- **根因**：S6c-fix1 §7 让参考图 = 当前背景；第一次换成生成图后，当前背景 URL 是 `/generated/scene-<id>-desktop.png`（文件在 `var/generated/`，`GENERATED_DIR`），但 `session.ts` 用 `resolveClientAssetPath()` 把它映射到 `apps/client/public/generated/...`（不存在）→ 第二次生图上传参考图时 `readFileSync` 失败。
- **修法**：新增纯函数 `resolveReferencePath(url, dirs)`（`apps/server/src/scene/referencePath.ts`）——`/generated/` 开头解析到生成目录（复用 `imageGen.ts` 的 `defaultOutDir()`），其余仍走客户端静态目录（`clientPublicRoot()`）。`session.ts` 用它替换原来的 `resolveClientAssetPath`；生成目录优先取注入的 `sceneImageGen.outDir`（与落盘位置一致），否则 `defaultOutDir()`。
- **可观测**：换背景任务 `failed` / `rejected` 时 `session.ts` 打 `logTurn("scene_failed", {error})` / `logTurn("scene_rejected", {note})`（不含 Key、不含完整提示词）；两者加入 `obs/summarize.ts` 的 `ERROR_EVENTS`，`error` / `note` 列入 `obs/sanitize.ts` 白名单 → 观测页错误统计可见。
- **测试**：
  - `apps/server/test/referencePath.test.ts`：生成图 URL → 生成目录；默认背景 / 其它 URL → 客户端静态目录。
  - `apps/server/test/sceneSecondBackground.test.ts`：真实生图路径（假 `fetchImpl` + 临时 `outDir` + 可注入时钟跳过 45s 冷却）——第一次 ready 的生成图落盘、第二次也 ready、第二次参考图 = 第一次生成图；无 `scene_failed`。
  - `apps/server/test/sceneLogging.test.ts`：扩写非法 → `scene_failed` 带 `error` 且进观测面板；扩写被拒 → `scene_rejected` 带 `note` 且进面板。

### §1 协议与服务端
- `packages/protocol/src/messages.ts`：`sessionPayloadSchema` 新增
  - `background: { label: string; urls: {desktop,mobile} } | null`（来自 `sceneJob.lastReadyLabel/lastReadyUrls`，没换过为 null）；
  - `transcript: Array<{role,text}>`（来自 `session.history`，最多最近 40 条；assistant 多句按换行原样保留）。
  - 两字段都可选，缺省按 null / [] 处理，旧客户端解析不受影响。
- 服务端纯函数 `resumePayload(session)`（`session.ts`，`TRANSCRIPT_LIMIT = 40`）。`handleHello` 的 `session` 消息改为 `{ snapshot, ...resumePayload(session) }`；新会话自然得到 `background: null, transcript: []`。
- **测试**：`apps/server/test/sessionResume.test.ts`（换背景成功 → 恢复时 background 的 label/urls 与 ready 一致；transcript 与 history 一致；新会话 null / []；>40 条只留最近 40 条）；`packages/protocol/test/sessionResume.test.ts`（schema 兼容与解析）。

### §2 客户端
- 新增 `apps/client/src/live/sessionRestore.ts`：
  - `applySessionRestore(payload)`：带 `background` → 调 `applyResumeBackground(urls)` 直接切背景；把 `transcript` 里 `role:"user"` 的条目存入 `useSessionRestoreStore.userLines`。
  - `apps/client/src/live/scene/status.ts`：新增 `direct` 标记 + `applyResumeBackground()`——设置 `backgroundUrl` 但**不**改 `display`（不显示「生成中」）、`direct: true`（Live 跳过交叉淡入）。`handleSceneStatus ready` 设 `direct: false`（实时换背景仍交叉淡入）。
  - `apps/client/src/live/danmaku.ts`：新增纯 reducer 动作 `RESTORE_USER`——按顺序追加 user 弹幕，与已有同文本用户弹幕去重；assistant 不进弹幕。
  - 接线：`connection.ts` 收到 `session` 时调 `applySessionRestore`；`Live.tsx` 订阅 `useSessionRestoreStore` 排空进弹幕；`StageRenderer.tsx` 的 `CrossfadeBackground` 按 `animate={!backgroundDirect}` 决定是否播淡入。
- 剧情进度（顶栏标题 + 进度点）仍由 `snapshot`（`applySnapshot` → `node`）恢复，未改动。
- **测试**：`apps/client/test/sessionRestore.test.ts`（直接切背景且 `direct=true`、`display` 仍 idle；只恢复 user 条目；reducer `RESTORE_USER` 顺序追加 + 去重 + 保留 guide）。

### §3 测试（含 e2e）
- 服务端集成 + 协议 + 客户端 reducer 单测见上（§1 / §2）。
- e2e：`e2e/s6l-fix1.spec.ts`——发消息 → 触发换背景并等 ready → `page.reload()` → 断言背景仍是生成图（`/generated/`）、用户弹幕（含「你好」「换背景到海边」）仍在、剧情节点不变。**未运行**（用户 2026-10-28 决定 e2e 只在冻结点统一跑一次）。

### §5 思考时的反应音是「男声」
- **根因**：反应音是 S3 用空 `FISH_VOICE_ID` 合成的（本机只有 `FISH_VOICE_ID_YUNA`），`make-sfx.ts` 没传 `reference_id` → Fish 默认音色。
- **修法**：
  - 反应音按角色：`apps/client/public/characters/<id>/sfx/react-*.mp3`。`characters.ts` 新增 `reactionSfxFiles` 与 `reactionSfxUrls(id)`；`reactionSfx.ts` 的 `ReactionDeps.urls` 改为**动态函数** `() => readonly string[]`，`arm()` 时按当前角色取；某角色没有反应音 → 空数组 → 不播（不回退全局）。删除 `REACTION_SFX_URLS` 常量与全部引用。
  - 删除旧的全局 `apps/client/public/sfx/react-{hmm,mm,ah}.mp3`（`public/sfx/` 目录已移除）。
  - `make-sfx.ts` 加 `--character <id>`；音色用该角色的 `fishVoiceIdEnv`（`resolveSfxVoiceId`，与会话层同一规则，复用角色包字段而非重写）；音色变量为空 → **抛错退出**（`main()` 捕获 → `process.exitCode = 1`）；输出到 `characters/<id>/sfx/`。文本保持原三条不变。
  - 运行一次 `pnpm --filter @mira/server exec tsx scripts/make-sfx.ts --character yuna`：三条真实 Fish 合成成功（27584B / 24240B / 24658B），**无 Fish 报错**。
- **测试**：`apps/client/test/reactionSfxCharacter.test.ts`（URL 随角色变化、无反应音角色 `arm()` 不播、`REACTION_SFX_URLS` 已删除、按动态 urls 取音）；`apps/server/test/makeSfx.test.ts`（按 `fishVoiceIdEnv` 取音色、为空抛错、`--character` 解析、输出目录、三条文本原样）。

### §6 预录声音叠加
- **根因**：`fallback.ts` 的 `playLocalAudio()` 每次新建一个 `AudioContext` 旁路播放，不受打断控制（`installOfflineFallback` 与 `sceneFallback` 都走它）→ 与主通道 beat 音频叠加。
- **修法**：
  - 新增 `apps/client/src/core/localAudio.ts`：单一音源仲裁 —— beat 播放期间来的本地语音排队（beat 结束再播，沿用 sceneFallback 语义）；beat 开始停掉正在播的本地语音；打断全停并清队列；检测到叠加时回调。
  - `audio.ts`：本地语音改用共享 `ensureContext()` 播放（`playLocalVoiceAudio`），导出 `playLocalVoice` / `stopLocalVoice` / `isLocalVoicePlaying`；`schedule()` 在真实 / 无声 beat 开始时 `localAudio.beatStarted()`、结束时 `localAudio.beatEnded()`；仲裁的 `onOverlap` → `pushEvent("audio_overlap")`。
  - `fallback.ts` 的 `playLocalAudio` 改为 `playLocalVoice(url)`（**删掉 `new AudioContext()`**）；`sceneFallback.ts` 默认 sink 不变（经 fallback.ts 走主通道）。
  - 打断执行器：`controller.ts` 的 `stopAudio` 增加 `stopLocalVoice()`；`interrupt.ts` 新增后置条件 `localVoiceActive`（违反 → 「本地兜底语音未停止」）。
- **测试**：`apps/client/test/localAudio.test.ts`（单测：beat 期间排队、beat 开始停本地、打断全停、替换不叠加；属性测试 fast-check：随机操作序列下「本地音源同时在播 ≤ 1」且「beat 在播时本地不在播」）。`interrupt.test.ts` / `interruptMatrix.property.test.ts` 同步补齐 `localVoiceActive`。

## 关卡 1–5 落实（Claude 决定）

1. **YAGNI**：只恢复背景与用户弹幕；未做持久化存储；未恢复字幕（assistant 不进弹幕，避免刷新后突然出现旧字幕）。
2. **端口/适配器**：未碰外部服务，只扩 `session` 消息。
3. **函数式核心**：服务端 `resumePayload(session)` 纯函数；客户端恢复走 reducer（`RESTORE_USER`）与 store（`applyResumeBackground`）。
4. **契约式设计**：服务端为唯一事实来源；`session` 新字段可选，缺省 null / [];transcript 上限 40。
5. **测试奖杯**：服务端集成 + reducer 单测 + 1 条刷新 e2e（已写未跑）。

## 变更清单

- 新增：`apps/server/src/scene/referencePath.ts`、`apps/client/src/core/localAudio.ts`、`apps/client/src/live/sessionRestore.ts`、`e2e/s6l-fix1.spec.ts`、`apps/client/public/characters/yuna/sfx/react-{hmm,mm,ah}.mp3`。
- 新增测试：`referencePath.test.ts`、`sceneSecondBackground.test.ts`、`sceneLogging.test.ts`、`sessionResume.test.ts`（server）、`sessionResume.test.ts`（protocol）、`makeSfx.test.ts`、`sessionRestore.test.ts`、`reactionSfxCharacter.test.ts`、`localAudio.test.ts`。
- 修改：`session.ts`、`obs/summarize.ts`、`obs/sanitize.ts`、`make-sfx.ts`、`messages.ts`、`audio.ts`、`connection.ts`、`controller.ts`、`fallback.ts`、`interrupt.ts`、`reactionSfx.ts`、`status.ts`、`sessionRestore.ts`、`Live.tsx`、`StageRenderer.tsx`、`characters.ts`、`danmaku.ts` 及相应测试。
- 删除：`apps/client/public/sfx/react-{hmm,mm,ah}.mp3`（旧全局文件）与 `REACTION_SFX_URLS`。

## 未决 / 备注

- e2e 按要求**未运行**。`smoke:scene`（真实生图）未运行——涉及真实 image 调用，超出「只允许 §5 一次真实 Fish 调用」的范围。
- `pnpm make-sfx`（`apps/server`）现在默认第一个角色，等价于 `--character yuna`。
