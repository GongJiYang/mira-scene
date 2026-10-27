# S5 报告：Mock 真实语音 + 移动端适配 + S4 遗留修复 + WebM 剧情视频

基线：最新提交 `6edb91a`。**未 commit**。未改 `docs/architecture/`。未碰 `tools/`、`skills/`（用户/其他会话的改动原样保留）。

## 0. 验收结果

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 4 个 workspace 全部 Done |
| `pnpm test` | ✅ 50 个文件 / **479 tests passed**（新增约 39 条；原有 440 条全部保持通过，2 处按 §5 改了字面值，见 §5） |
| `pnpm smoke` | ✅ `SMOKE OK`（含 `faults:["tts"]` 与打断/时限步骤） |
| `pnpm e2e` | ✅ **11 passed / 9 skipped**（exit 0；3.0m）。`e2e/mobile.spec.ts` 单跑：**5 passed**（iphone-13 project 下切换三种视口），desktop project 下按设计 skip |

`e2e/mobile.spec.ts` 三种视口的实测：

```
✓ 1 [iphone-13] 视口 iphone-se       无横向滚动、背景用 _v 素材、照片放大后不挡脸（25.2s）
✓ 2 [iphone-13] 视口 iphone-13       同上（24.7s）
✓ 3 [iphone-13] 视口 desktop-1280x800 同上（24.7s）
✓ 4 [iphone-13] S5 §5 剧情视频        进入 ending 后视频出现；播放中被按住说话打断（32.3s）
✓ 5 [iphone-13] S5 §5 视频失败降级    ?fail=video → 视频不出现，改为静态图 + 轻提示（31.5s）
```

首次跑 `pnpm e2e` 前需要 `npx playwright install chromium`（沿用 S4 的说明）。

---

## 1. 变更清单

### 1.1 服务端

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/adapters/mock/voiceKey.ts` | 新增 | 纯函数 `normalizeVoiceText` / `voiceKey(text, emotion)`：NFKC + 表意标点归一再 sha256 取前 16 位 |
| `src/adapters/mock/voiceManifest.ts` | 新增 | manifest 的 zod schema、`loadVoiceManifest`（不存在→空表，非法→抛错）、`clipsDirFor`、`writeVoiceManifest` |
| `src/adapters/mock/mockTts.ts` | 修改 | 新增 `manifestPath` / `log` 选项；命中→mp3，未命中→占位 WAV + `voice_fallback` 日志（§1） |
| `src/config.ts` | 修改 | `ServerConfig.voiceManifestPath`（默认 `<仓库根>/assets/voice/manifest.json`，`VOICE_MANIFEST` 可覆盖） |
| `src/index.ts` | 修改 | `createMockTts({ manifestPath, log })`：manifest 非法时**启动即抛错** |
| `src/director/director.ts` | 修改 | ending 分支加 `media = { type: "video", id: "clip_ending" }`（§5） |
| `src/adapters/media/presetMedia.ts` | 修改 | 支持 video：返回 `/stage/videos/<id>.webm`（照片仍是 `/stage/photos/<id>.png`） |
| `scripts/record-voices.ts` | 新增 | 遍历 Mock 剧本用真实 Fish TTS 录制预录片段（不运行） |
| `package.json` | 修改 | 新增依赖 `zod@^3.25.76`（见 §6.1） |
| `test/voiceKey.test.ts` | 新增 | 9 条：规整、稳定性、情绪/台词区分、定长 hex |
| `test/mockTts.test.ts` | 新增 | 7 条：临时目录假 manifest + 假 mp3 的查表、降级日志、缺文件、非法 manifest/JSON、AbortSignal |

### 1.2 客户端

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/stage/photoRect.ts` | 新增 | `FACE_BOX`、`faceBoxRect`、`rectsIntersect`、纯函数 `photoRect(stage, faceBox)` |
| `src/stage/layers.ts` | 修改 | 新增 `pickStageAsset` / `videoUrl` / `STAGE_VIDEOS`；转出 `FACE_BOX`；`photoLayer` 不为 video 出照片层；`orientationFor` 转 deprecated |
| `src/stage/StoryVideo.tsx` | 新增 | 视频外壳：`<video>`、canplay/ended/error 监听、5s 加载超时、打断即暂停 |
| `src/state/storyMedia.ts` | 修改（**只新增**） | 视频子状态：`VideoState` / `videoReducer` / `isVideoVisible` / `isVideoActive` / `isVideoStale` / `turnIdFromStoryEventId`。**既有照片转移一行未改** |
| `src/view/Stage.tsx` | 修改 | ResizeObserver 量舞台框 → `pickStageAsset`；放大态照片用 `photoRect`；渲染 `<StoryVideo>` / 失败静态图 / 提示；`TURN` 事件驱动视频打断 |
| `src/core/audio.ts` | 修改 | 每次 `pointerdown` / `keydown` / `touchend` 按需 `resume()`；`visibilitychange` 置位（§2） |
| `src/stage/stage.css` | 修改 | `100dvh`、`env(safe-area-inset-*)`、`overflow-x: hidden`、视频层与失败静态图样式 |
| `index.html` | 修改 | `viewport-fit=cover` |
| `test/photoRect.test.ts` | 新增 | 4 条单测 + 1 条 fast-check 属性（1000 次） |
| `test/stageAsset.test.ts` | 新增 | 2 条单测 + 1 条 fast-check 属性（1000 次） |
| `test/storyVideo.test.ts` | 新增 | 15 条单测 + 1 条 fast-check 属性（1000 次，随机事件序列） |

### 1.3 素材、脚本、e2e

| 文件 | 类型 | 内容 |
|---|---|---|
| `assets/voice/manifest.json` | 新增 | 空表 `{"version":1,"clips":{}}` |
| `assets/voice/clips/.gitkeep` | 新增 | 预录 mp3 的落点 |
| `scripts/make-placeholder-video.sh` | 新增 | ffmpeg：b1→b3 交叉淡入 + 缓慢推镜 → `clip_ending.webm` |
| `apps/client/public/stage/videos/clip_ending.webm` | 生成入库 | VP9 / 720×1080 / 6.0s / 无音轨 / **186,581 bytes**（< 1.5MB） |
| `e2e/mobile.spec.ts` | 新增 | 三种视口 + 视频三条用例 |
| `package.json`（根） | 修改 | 新增脚本 `voices:record` |

---

## 2. 每条架构关卡结论 → 代码位置

| 结论 | 落点 |
|---|---|
| §1 Mock 语音方案 B（纯函数 `voiceKey`） | `apps/server/src/adapters/mock/voiceKey.ts` |
| §1 manifest 读取/校验（非法→启动抛错、缺失→空表） | `voiceManifest.ts` + `index.ts`（`createMockTts` 创建时校验） |
| §1 只改 Mock 的 TTS 适配器，`TTSPort`/session/导演层不动 | 只动 `mockTts.ts`（接口签名未变）；`ports.ts`/`session.ts`/`director` 的 TTS 调用未改 |
| §1 降级为占位音 + `voice_fallback` 日志 | `mockTts.ts` 的 `synthesize` 内 |
| §2 iOS 音频解锁加固 | `apps/client/src/core/audio.ts`（`installAudioUnlock` / `ensureUnlocked` / `needsUnlock`） |
| §3 竖屏适配（viewport-fit / 100dvh / safe-area / 无横向滚动） | `index.html` + `src/stage/stage.css` |
| §4 ① `pickStageAsset(舞台框尺寸)` + ResizeObserver | `src/stage/layers.ts`（函数）、`src/view/Stage.tsx`（`useElementSize`） |
| §4 ② `photoRect` + `faceBox` | `src/stage/photoRect.ts`（定义）、`src/stage/layers.ts`（转出）、`src/view/Stage.tsx`（应用到放大态照片） |
| §4 属性测试（各 1000 次） | `test/photoRect.test.ts`、`test/stageAsset.test.ts` |
| §5 导演层 ending 加 video media | `apps/server/src/director/director.ts`（`advancedTo === "ending"` 分支） |
| §5 `presetMedia` 支持 video | `apps/server/src/adapters/media/presetMedia.ts`（`presetMediaUrl`） |
| §5 视频状态 reducer + 单测 + 属性测试 | `apps/client/src/state/storyMedia.ts`（`videoReducer`）+ `test/storyVideo.test.ts` |
| §5 视频组件 | `apps/client/src/stage/StoryVideo.tsx`（外壳）+ `src/view/Stage.tsx`（挂载/打断/失败静态图） |
| §5 e2e（出现/打断/失败） | `e2e/mobile.spec.ts` 后两个 describe |
| §5 占位素材脚本 | `scripts/make-placeholder-video.sh` |
| §5 契约属性测试（1000 次） | `test/storyVideo.test.ts` 末段 |

---

## 3. faceBox 数值

以**舞台百分比**（0–1）表示，`assets/parts/master_clean.png`（1024×1536，2:3，`object-fit: cover` 铺满舞台）标定：

```ts
FACE_BOX = { left: 0.33, top: 0.05, width: 0.34, height: 0.37 }   // x 0.33–0.67，y 0.05–0.42
```

- 依据：面部（发际线→下巴）约 x 0.38–0.63、y 0.16–0.39；把头顶头发（y≈0.05）与两侧耳饰外扩进来，取上表。
- 放大态照片的几何：水平居中；纵向放在「脸上方 / 脸下方」更宽裕的一侧，四周留 `3%` 舞台高的空隙；宽度上限 `62%` 舞台宽，高宽比 `1.18`（与 `stage.css` 一致）。
- `photoRect` 后置条件：结果落在舞台内 且 与 `faceBox` 像素区域**不相交**（属性测试 1000 次覆盖宽 280–1200px、2:3 ±2% 抖动）。

---

## 4. 录制脚本用法（**本批未运行**）

```bash
# 前提：仓库根 .env 里 FISH_API_KEY 有余额
pnpm voices:record
```

- 遍历 `mockLlm.ts` 的剧本（4 个节点 × 6 种意图 + 主动开口轮），对每句台词 `buildTtsText(emotion, say)` 后调用真实 Fish TTS。
- 产物：`assets/voice/clips/<voiceKey>.mp3` + 更新 `assets/voice/manifest.json`（`{version, clips}`，键排序）。
- **已存在的 key 跳过**，每录一句即落盘，可重复运行、增量补录。
- 未在测试或本次执行中运行（账户目前没有余额）。

---

## 5. 与现有测试冲突：逐条列出（铁律 1）

§5 明确要求「导演层在 ending 分支加上 `media = { type: "video", id: "clip_ending" }`」，而现有两条测试把它当作不变量断言。按铁律 1，**只改字面值 / 最小结构**，不逐条保留原意图的地方已在下方标注。

| # | 文件 | 原断言 | 改动 | 性质 |
|---|---|---|---|---|
| 1 | `apps/server/test/director.test.ts`（"进入 ending"） | `media: null` | `media: { type: "video", id: "clip_ending" }`；标题同步改为「media=剧情视频 clip_ending」 | **字面值**（逻辑仍是「ending → wide / warm_glow」，只那一行值变了） |
| 2 | `apps/server/test/director.property.test.ts`（属性后置条件） | `media !== null ⇒ 一定是 photo_letters / reveal / close_up / rain_stop` | 增加 `media.type === "video"` 分支：断言 `clip_ending / ending / wide / warm_glow`；照片分支保持原样 | **结构性**（这条不是纯字面值）：不变量意图仍是「media 只能来自剧情推进」，只是把 ending 的新规则补进同一不变量 |

其余 440 条测试未做任何改动。没有改测试的**意图**（第 2 条是唯一一处需要按 §5 扩写不变量的地方）。

---

## 6. 歧义与偏差（需主审确认）

### 6.1 zod 作为服务端依赖（授权范围外的必要改动）
授权范围未列 `apps/server/package.json`，但 §1 明确要求「manifest 格式非法（**zod 校验失败**）→ 启动报错」。服务端此前没有直接依赖 zod（只有 `@mira/protocol` 有）。处理：给 `apps/server` 加 `"zod": "^3.25.76"` 并 `pnpm install --offline`（zod 已在 pnpm store，仅补软链，`pnpm-lock.yaml` +3 行）。若不允许，可改为手写校验器（契约行为不变）。

### 6.2 `?fail=video` 在客户端处理
§5 把 `?fail=video` 列为失败注入之一（D9 的故障表也含 `video`）。服务端的 `adapters/faults.ts` 不在授权范围，且 `FAULT_VALUES` 里没有 `video`（`parseFaults` 会忽略未知值）。处理：`?fail=video` 由**客户端**在视频 LOAD 时直接转 `ERROR`（`src/view/Stage.tsx` 的 `readFailVideo`）→ 走 `failed` 分支显示静态图 + 提示。服务端不感知，`hello.faults` 里的 `"video"` 被安全忽略。

### 6.3 视频经由状态机 C（storyMedia）承载
授权范围不允许改 `core/connection.ts` / `core/storyMediaLink.ts`，而服务端的 `media_ready` 会把视频一并送到 C。因此视频的「何时出现」由 C 的 `status === "shown" && media.type === "video"` 触发（正好对应「`storyMedia.ts` 只允许新增视频相关的状态和转移」）。副作用两点：
1. ending 轮的视频 `REQUEST → developing` 期间，C 会先渲染**空白相纸**（约 2.5s，直到 `media_ready`）；`media` 到达后立即换成视频。属占位 UI 的观感问题，未改既有照片转移。
2. ending 轮的 `media` 从「照片」变为「视频」，C 里 reveal 那张照片被替换。D34 的「照片保留」体现在 `photoReducer` 不因打断重置；具体到 ending 这一轮，媒体槽位归视频所有。

### 6.4 视频打断的例外是怎么实现的
- A 的 `currentTurnId` 是唯一判据：`Stage.tsx` 订阅它并派发 `TURN`；`videoReducer` 在 `TURN` 时若 `turnId !== currentTurnId` 且视频仍在 loading/playing → **`dismissed`**（立即结束、不恢复）。
- `LOAD` 对同一 `eventId` **幂等**，所以打断后即便 C 仍然是 `shown`，也不会重新加载/复活。
- 组件层：`status !== loading/playing` 时 `<video>.pause()`；`useDelayedUnmount(120ms)` 让层用 120ms 的 CSS 过渡淡出后在 DOM 里卸载（满足 e2e「300ms 内不可见」）。
- 注意：照片走的是 C 的 `processed` 去重、不受 `TURN` 影响，所以「照片保留、视频打断即结束」这条 D34 例外是**只对视频生效**的。

### 6.5 其它
- **e2e 视口切换放在 `e2e/mobile.spec.ts` 内**（`test.use` 三段 describe），未改 `playwright.config.ts`（不在授权范围）。三视口只在 `iphone-13` project 下跑一次，避免三倍重复；desktop project 下该文件按设计 skip。
- **`FACE_BOX` 定义在 `photoRect.ts`**（紧挨消费它的几何），并在 `layers.ts` 转出（§4② 说「在 layers.ts 或 manifest 里给角色定义」）。若要严格「定义在 layers.ts」，移动一行即可。
- **`orientationFor` 保留**并标注 `@deprecated`（既有单测 `stage.test.ts` 直接断言它）；`Stage.tsx` 已改用 `pickStageAsset(舞台框尺寸)`。
- **加载中的「很小的加载提示」未做**（§5 写的是「可以显示」，非必须）。
- 视频成功播放后没有「播放结束回到 closing 背景」的额外处理：ending 的 `fx = warm_glow` 本身就是 closing 背景，`ended` 后视频层淡出即回到背景 + 常驻角色。
- 舞台底部输入栏在矮屏仍需要竖向滚动（沿用 S4 结论，无横向滚动）。

---

## 7. iOS 真机手测清单（iPhone Safari）

只能在**真机 Safari** 上验证（桌面 Chrome / 模拟器复现不了 `interrupted` 态）。逐条记录「有声音 / 无声音」：

1. **首次进入后点击**：冷启动打开页面 → 点任意处一次 → 发送文字，第一句语音应当**有声**。
2. **首次进入后直接按 PTT**：不先点空白处，直接按住「按住说话」松开 → 回复应当有声（`pointerdown`/`touchend` 都会尝试解锁）。
3. **切到后台再回来**：说话中途把 Safari 切到后台 5s 再切回 → 下一次手势（点一下 / 按住 PTT）后回复应能出声（`visibilitychange` 置位 + 手势解锁）。
4. **来电 / 锁屏后恢复**：来电打断或锁屏，回到页面 → 第一次手势后应恢复（`interrupted` / `suspended` 都会被 `resume()`）。
5. **静音拨杆打开时**：WebAudio 在 iOS 上通常**不受静音键影响**（仍出声）；若实测无声，记录为已知差异（属 E1 范围，含「外放戴耳机提示」）。
6. **反复切前后台 3 次**：每次都应在下一次手势后恢复。
7. **打断体验**：说话中按住 PTT，应立即静音并进入倾听（Q1 ≤150ms，桌面已由 Playwright 覆盖，真机用慢放录屏核对）。

验收口径：1、2、3、4、6 必须「第一次手势后有声」；5 记录现象即可。

---

## 8. 安全与进程

- 全程未打印、未写入任何 Key；`PROVIDER_MODE=mock` 下不读凭据，测试与 e2e 均不发真实网络请求（Q10）。
- `pnpm voices:record` 已加入根 `package.json`，但**未运行**。
- e2e 结束后 dev server 随 Playwright 关闭，**5273 / 8887 已释放**（`lsof` 复核）。
- 未 commit。
