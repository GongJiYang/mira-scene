# S6g-A 执行报告

> 任务说明见 `docs/tasks/s6g-a.md`。执行者：Command Code（deepseek-v4-flash）。
> 上一次会话因网络断线中途退出，本报告在已有未提交改动（含删除夏凛）基础上续做，未推倒重来，未恢复任何已删除的夏凛文件。

## §0 结果速览

- `pnpm typecheck`：全绿（protocol / server / client / tools）。
- `pnpm test`：**70 个测试文件 / 717 个用例全部通过**（0 失败）。
- 全量 e2e（`E2E_SERVER_PORT=8987 E2E_CLIENT_PORT=5373`）：**30 passed / 9 skipped / 1 failed**。
  - 唯一失败：`e2e/docs.spec.ts › 手机：目录收进抽屉，正文全宽`，断言 `documentElement.scrollWidth ≤ 390`，实测 **396（溢出 6px）**。该用例只测 `?docs=1` 文档页布局，**与本次改动无关**（未触碰 `DocsApp.tsx` / `docs.css`），且 `00-导读.md` 与 `docs.css` 在 HEAD 已提交、本次未改。属**既有问题**，未修（超出本任务范围）。
  - 端口 8987 / 5373 未被占用，直接使用，未换端口。

## §1 删除夏凛（D43）

### 1.1 删除的文件（逐个）

角色 / 素材 / 剧本：

- `characters/rin/content.json`、`characters/rin/pack.json`、`characters/rin/prompt.v1.md`、`characters/rin/scene.v1.md`、`characters/rin/voice-pack.json`
- `prompts/rin.v1.md`、`assets/voice/rin/manifest.json`、`assets/voice/rin/clips/.gitkeep`
- `assets/raw/**`（全部 33 张素材：master、背景 h/v、前景桌、五官差分、拍立得等）
- `assets/parts/**`（全部 17 张分层贴片）
- `apps/client/public/characters/rin/test-scene-desktop.png`、`-mobile.png`
- `apps/client/public/stage/`（`assets`、`photos`、`videos/clip_ending.webm` —— 随夏凛删除的 `/stage/` 素材目录）
- `scripts/make-placeholder-video.sh`（只为夏凛生成占位 ending 视频）

只服务夏凛的代码（分层立绘路径，grep 确认无其它使用方后删除）：

- `apps/client/src/App.tsx`（旧 Stage 视图入口，`?legacy=1`）
- `apps/client/src/view/Stage.tsx`、`apps/client/src/stage/layers.ts`、`apps/client/src/stage/charClip.ts`
- `apps/client/src/stage/develop.ts`（拍立得显影）、`apps/client/src/stage/photoRect.ts`
- `apps/client/src/stage/rain.ts`、`apps/client/src/stage/RainCanvas.tsx`、`apps/client/src/stage/camera.ts`、`apps/client/src/stage/stage.css`
- `apps/client/src/render/manifest.ts`（分层立绘素材清单）

保留并改造：`apps/client/src/stage/StoryVideo.tsx`（可复用给忧奈的 ending 视频，保留）。

### 1.2 删除的测试（逐个）及原因

- `apps/client/test/camera.test.ts`、`charClip.test.ts`、`develop.test.ts`、`manifest.test.ts`、`photoRect.test.ts`、`rain.test.ts`、`stage.test.ts`、`stageAsset.test.ts`、`stageIntegration.test.ts`：**只测夏凛分层立绘 / 雨 / 拍立得素材**，对应实现已删，用例随之删除。
- `e2e/stage.spec.ts`、`e2e/mobile.spec.ts`：均依赖 `?legacy=1`（旧 Stage 视图，已删）与 `src/stage/photoRect`（已删）；`mobile.spec.ts` 甚至 import 了已删模块，无法编译，整文件删除。
- `e2e/live.spec.ts`：删除其中「手机竖屏角色基底在桌沿下方被裁切」用例（`test.skip(true)` 且断言夏凛分层图层 `char:base` / `fg:table`，素材已删）。

### 1.3 改写的测试

- `apps/server/test/helpers/pack.ts`：删除 `testPacksWithRinVisible()` / `testPacksYunaOnly()`，`testPack()` 只接受 `"yuna"`。
- 服务端全部依赖 rin 的用例改为忧奈：`fallback`、`sessionQuota`、`deepseek`、`faults`、`commandcode`、`nudge`、`ttsVoice`、`characterPacks`、`prompts`、`mockLlm`、`imageGen`、`integration`、`media`、`director`、`pack`。
  - `fallback.test.ts` / `ttsVoice.test.ts` / `characterPacks.test.ts`：删除「两个角色互不相同」等双角色对比用例（只剩一个角色，比较失去意义），保留单角色断言。
  - `media.test.ts`：原「rin 会话发起媒体 → 切到 yuna 连接收不到」改为「会话 A 发起媒体 → 同连接新建会话 B 收不到」，仍验证 S6b-fix1 §3 的解绑行为。
  - `pack.test.ts`：改为只校验忧奈（含新增的 `nodes` 视觉配置断言）。
- 客户端：`performance.test.ts`（删掉 face/hands/handsTransition 断言）、`viewModelAdditions.test.ts`、`interruptMatrix.property.test.ts`（`BeatLook` 去掉 `hands`）、`yunaParams.test.ts`（`idleActionParams` 去掉第三个参数）。

### 1.4 S6f 遗留清理

- 删除 pack 的 `hidden` 字段（schema、`Pack` 类型、`parsePack`、`defaultCharacterId`），以及 `session.ts` 的 `pack.hidden` 校验、`index.ts` 的隐藏角色跳过逻辑。`renderer.kind` 只剩 `live2d`（`rendererSchema` 由 discriminatedUnion 改为单对象）。
- 客户端 `ClientCharacter` 删除 `renderer` / `hidden` 字段；`VISIBLE_CHARACTERS` 直接等于 `CLIENT_CHARACTERS`。
- 删除测试辅助 `testPacksWithRinVisible`。

### 1.5 导演层写死视觉改为角色包配置

- 删除导演层写死的 `rain_heavy`（会话首 beat）/ `rain_stop` / `warm_glow` / `photo_letters` / `clip_ending`。
- protocol `fxSchema` **保留旧值** `rain_heavy / rain_stop / lights_dim / warm_glow`（删除会牵连太广），新增 `stream_dim / hearts`；旧值不再被使用。

## §2 剧情节点视觉搬进角色包

`characters/yuna/pack.json` 新增 `nodes`（原文）：

```json
"nodes": {
  "arrive": { "fx": null },
  "probe": {},
  "reveal": { "camera": "close_up", "fx": "stream_dim", "media": { "type": "photo", "id": "photo_first_stream" }, "action": "show_item" },
  "ending": { "camera": "wide", "fx": "hearts", "media": { "type": "video", "id": "clip_offline" } }
}
```

- `pack.ts` 新增 `nodeVisualSchema` + `normalizeNodeVisuals()`（缺省 / `null` 统一成 `null`），`Pack.nodeVisuals`。
- `DirectorContext` 新增 `nodeVisuals`；`direct()` 只从 `ctx.nodeVisuals[advancedTo]` 取 camera / fx / media / 强制动作；`session.ts` 用 `session.pack.nodeVisuals` 注入。
- **后置条件属性测试**（`director.property.test.ts`）改写为：「任意 LLM 输出都不会产生角色包里没有的 fx / media id」——推进 beat 的 camera/fx/media 必须逐字段等于 `nodeVisuals[advance]`，非推进 beat 必须全为 null。500 次 × 50–200 beat 通过。

## §3 Live2D 舞台补渲染

### 3.1 镜头（`cameraFor`，纯函数，有单测）

`apps/client/src/render/live2d/cameraFor.ts`：`cameraFor(camera, orientation) → { scale, tx, ty }`，作用在 `.live-camera` 容器（含背景 + 画布 + 特效层），600ms `ease-out` 缓动。

| camera | landscape（桌面） | portrait（手机） |
| --- | --- | --- |
| `wide` / null | `scale 1, tx 0, ty 0` | `scale 1, tx 0, ty 0` |
| `close_up` | `scale 1.9, tx 0, ty 0.14` | `scale 1.7, tx 0, ty 0.1` |

`tx / ty` 是画布宽 / 高的比例（正为右 / 下）。`.live-camera` 带 `data-camera`，e2e 据此断言。

### 3.2 特效

- `stream_dim`：`.live-fx-dim` 叠 40% 暗色（`rgba(8,6,12,0.4)`），z-index 6，`data-testid="fx-stream-dim"`；弹幕区在舞台之外，不受影响。
- `hearts`：`.live-fx-hearts` 暖色光晕 + 皮套 `ParamHeart`（由 `yunaParams` 写，0.4s 渐入），`data-testid="fx-hearts"`。
- 特效来自 `visual.fx`（剧情层），打断不撤销。

### 3.3 reveal 截图弹窗（`ScreenshotCard`）

- 舞台右下角「截图」卡片（不是聊天气泡）：`developing` 显示三点加载态；`ready / shown` 显示生成图；`fallback` / 图片加载失败显示预置 `/characters/yuna/photo_first_stream.png`，**不提示错误**。
- `data-testid="screenshot-card"`，可点 `screenshot-close` 关闭；打断不撤销（数据来自 C，不经 turnId）。

### 3.4 ending 视频

- `<video>` 挂载条件为「视频槽位 `shown` 且有 url」（**关键修复**：原先只在 `playing` 时挂载 → `canplay` 永不触发 → 死锁；现在先挂载再等 `canplay`，可见性由 `playing` 决定，非 playing 时 `visibility:hidden`）。
- 进入 ending 即（由视频槽位驱动）加载；加载中不黑屏（保持舞台）；播完停在最后一帧；打断 → 200ms 淡出暂停、回倾听、不恢复；加载失败 → 不显示视频、保持舞台、不报错。
- mock 预置媒体地址从 `/stage/...`（已随夏凛删除）改为 `/characters/yuna/...`（见 §7 改动）。

### 3.5 布局

桌面与手机共用 `StageRenderer`（都渲染 `.live-camera` + fx + 弹窗 + 视频），仅相机常量按方向不同；手机菜单另有入口按钮（§5）。

## §4 表演修正

### 4.1 眉毛（D46①）

查 `apps/client/public/models/yuna/yuna.physics3.json`，眉毛物理映射为：

| 物理输入 | 输出 | Scale | VertexIndex |
| --- | --- | --- | --- |
| `ParamBrowL` | `ParamBrowLY` | 1.8 | 1 |
| `ParamBrowL` | `ParamBrowLAngle` | 1 | 2 |
| `ParamBrowR` | `ParamBrowRY` | 1.8 | 1 |
| `ParamBrowR` | `ParamBrowRAngle` | 1 | 2 |

`EMOTION_PARAMS` 改为写物理**输入**：

- `guarded`：`ParamBrowL = -0.4`、`ParamBrowR = -0.4`（原先写输出 `ParamBrowLY/RY = -0.4`，会被物理覆盖）。
- `sad`：`ParamBrowL = -0.55`、`ParamBrowR = -0.35`（左右不同 → 物理输出左右眉形不同，形成八字眉；原先写 `ParamBrowLAngle/RAngle = ∓1` 无效）。

### 4.2 耳朵

`ParamEarsLX1/RX1` 是物理输出，写它无效 → 从待机小动作删除（同时删除 `IDLE_EAR_SEC` / `IDLE_EAR_AMPLITUDE` 与输出恒 0 的 `ParamEarsLX1/RX1` 补齐）。

### 4.3 抱熊

- 从待机随机小动作删除（`idleActionParams` 只剩「瞟向一侧」与「什么都不做」两档）。
- 只在 `silentAction = show_item` 出现：`petGradient(elapsedSec, durationSec)`，0.6s 线性渐入、中间保持 1、结束 0.6s 渐出（`PET_FADE_SEC = 0.6s`，`show_item` 时长 3s）。
- e2e 截了渐变中间帧：`e2e/out/s6ga-pet-mid.png`。

### 4.4 视线限幅

- 待机瞟眼与 `glance` 的视线并入 `look` 后**先过 `clampView()`**（唯一限幅出处），不再绕过产品侧上限。
- 禁止参数清零仍放在「输入 → 输出」的最后统一截断步骤（`FORBIDDEN_KEYS` 恒为 0），属性测试不变。

### 4.5 `sceneJobReducer.failed`

`apps/server/src/scene/job.ts`：`failed` 现在只在 `writing / generating` 下生效——已 `ready` 的任务不会被迟到的超时改成 `failed`。新增单测 `scene.test.ts › S6g-A §4.5`。

## §5 入口按钮

- `uiText.ts` 新增：`docs: "文档"`、`obs: "观测"`、`menu: "菜单"`。
- `apps/client/src/live/entries.tsx`：`LiveEntries`（桌面顶栏右侧，`.live-hud` 内）与 `MobileMenu`（手机顶栏可展开菜单，点外部收起）。
- 跳转：`?docs=1&doc=docs/architecture/00-%E5%AF%BC%E8%AF%BB.md`（默认打开 `00-导读.md`）与 `?obs=1`。
- 桌面顶栏入口 `data-testid="entry-docs"` / `entry-obs`；手机菜单 `mobile-menu-toggle` / `mobile-menu-panel`。

## §6 观测页

`ObsApp.tsx` 瀑布条改为**所有行共用同一时间刻度**：新增纯函数 `turnTotalMs(turn)`（一行各阶段累计的最大毫秒数）与 `waterfallScaleMs(turns)`（取最近 20 轮里最长的一轮，至少 1）；`TurnBar` 接收 `scaleMs`。新增单测 `apps/client/test/obsWaterfall.test.ts`（3 例）。

## §7 测试与 e2e

### 7.1 单元 / 属性测试

- `pnpm typecheck`：全绿。
- `pnpm test`：70 文件 / **717 用例全部通过**。
- `director.property.test.ts`：把「camera/fx/media 只能来自剧情规则或会话第一个 beat」改为「只能来自角色包 `nodeVisuals`」，500×50–200 beat 稳定通过（含 20s 超时余量），未出现偶发失败，**未放宽强度、未固定 seed**。
- 新增：`scene.test.ts › §4.5`、`obsWaterfall.test.ts`、`pack.test.ts › nodes 视觉配置`、`director.test.ts` 的 reveal/ending/首 beat 断言更新。

### 7.2 e2e（`E2E_SERVER_PORT=8987 E2E_CLIENT_PORT=5373`）

新文件 `e2e/s6ga.spec.ts`：

1. `arrive → reveal → ending 截图 + 四情绪`（desktop + iphone-13）
   - `s6ga-arrive.png` / `s6ga-arrive-mobile.png`：`data-camera=wide`。
   - 第 3 轮进 reveal：`data-camera=close_up` + `fx-stream-dim` 可见 + `screenshot-card` 可见且卡片内有图 → `s6ga-reveal.png` / `s6ga-reveal-mobile.png`。
   - 第 4 轮进 ending：`data-camera=wide` + `fx-hearts` 可见 + `story-video` `data-status=playing` → `s6ga-ending.png` / `s6ga-ending-mobile.png`。
   - 四情绪（mock 节点 look 恰为 calm/guarded/sad/warm）：`s6ga-emo-calm.png`、`s6ga-emo-guarded.png`、`s6ga-emo-sad.png`、`s6ga-emo-warm.png`（四张 md5 各不相同）。
   - 全程断言 Live2D 画布非空（`waitLive2DPainted` 读 WebGL 像素）。
2. `打断不撤销截图弹窗（D27）`：reveal 后按住说话，卡片仍在。
3. `截图弹窗可点关闭`。
4. `抱熊只在 silentAction=show_item 出现（渐入中间帧）` → `s6ga-pet-mid.png`。
5. `§5 入口按钮`：桌面顶栏「文档」「观测」可见、文字正确、能跳 `docs-app` / `obs-app`；手机菜单里同样可跳转。

`e2e/s6ga.spec.ts` 结果：**10 passed / 2 skipped**（按布局互斥跳过）。

全量 e2e 结果：**30 passed / 9 skipped / 1 failed**（1 failed = 见 §0 的既有 docs 手机溢出，与本任务无关）。

## §8 遗留问题 / 说明

1. **docs 手机页 6px 横向溢出**（`e2e/docs.spec.ts` 手机用例失败）：既有问题，与 S6g-A 无关，未修（超范围）。建议单开一个 docs UI 小任务处理。
2. **`protocol` 旧 fx 值保留**：`rain_heavy / rain_stop / lights_dim / warm_glow` 仍在 `fxSchema` 里但已不再产生（删除牵连太广，按任务 §1 保留）。
3. **相机常量（`CLOSE_UP_TRANSFORM`）为初值**：桌面 `1.9 / ty 0.14`、手机 `1.7 / ty 0.1`，以 e2e 截图 `s6ga-reveal*.png` 人工核对后可能微调。
4. **眉毛物理为摆锤（Cosine/Angle）**：写入的是物理输入，实际输出角度经物理计算后与 `输入 × Scale` 非严格线性；方向与左右差异符合预期，最终观感以 `s6ga-emo-guarded/sad.png` 人工确认为准。
5. **ending 视频**：本批仍是现有不透明片段（`/characters/yuna/clip_offline.webm`），透明版留到 S6g-B（D44）。
6. **mock 预置媒体路径**：`index.ts` 的 mock `createPresetMedia` 的 `basePath` / `videoBasePath` 由默认 `/stage` 改为 `/characters/yuna`（`/stage/` 已随夏凛删除）；`presetMedia` 默认值本身未改。
7. **未 commit**（遵守铁律）。
