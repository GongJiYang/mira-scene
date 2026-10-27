# S6c 执行报告：弹幕换背景（场景扩写 + 构图锁 + 参考图生图）

> 执行者：Command Code（DeepSeek）。批次：S6c（s6c-scene 分支，worktree `/Users/gjy/mira-wt-s6c`）。
> 说明：本批由**两个会话接力**完成——上一个会话因接口限流中途退出、未写报告，工作区里已留下大量未提交改动。
> 本次先核对已完成部分，再补齐缺口（**未推倒重来**）。未 commit（铁律）。

---

## 1. 接力情况（本次做了什么）

上一次会话已完成绝大部分实现（纯函数、端口、session 旁路、协议、客户端 UI、e2e、单测/集成测试）。本次核对后**发现并修复 4 个真实缺口**，其余保持原样：

| # | 缺口 | 处理 |
|---|---|---|
| A | Mock 模式生图返回的 URL `/generated/test-scene-*.png` 在 `var/generated/` 里**不存在**，界面会 404 | 改为返回角色包目录下真实存在的预置测试图 `/characters/<id>/test-scene-desktop.<ext>`（`runner.ts` 新增 `mockSceneUrls`，按磁盘实际存在的扩展名选 `jpg`/`png`，兼容忧奈 `.jpg` / 夏凛 `.png`） |
| B | session.ts 里参考图路径用 `pack.dir.replace(/characters$/, ...)` 解析，**逻辑错误**（`pack.dir` 形如 `…/characters/yuna`，`/characters$/` 永远不匹配） | 新增 `pack.ts` 的 `clientPublicRoot()` / `resolveClientAssetPath(publicUrl)`，把 `pack.stage.background.*` 的公开 URL 正确映射到 `apps/client/public/` 下的本地文件 |
| C | `pnpm smoke:scene` 脚本**不存在**（任务 §6 明确要求） | 新增 `apps/server/scripts/smoke-scene.ts` + 根/服务端 `package.json` 脚本项 |
| D | 手机布局**没有渲染**转场状态条（`SceneStatusBar` 只在桌面布局里），e2e 手机用例失败 | 在 `MobileLive` 的舞台容器里补上 `<SceneStatusBar />`；e2e 手机/桌面双双通过 |

另外补齐了两处：
- **交叉淡入**：原实现只在 `.live-bg` 上写 `transition: opacity 1.2s`，但同一元素换 `background-image` 不会真正交叉淡入。改为 `StageRenderer` 的 `CrossfadeBackground`：保留旧图层，新图层 1.2 秒 `fade-in`（`@keyframes live-bg-fade-in`），动画结束卸掉旧层。
- **补集成测试**：新增 `sceneRunner.test.ts` 覆盖 §6 清单里需要假 fetch 的两条（生图超时、只成一张图）。
- **语音包清单**：`pnpm voices:list` 重新生成，把三类新兜底台词纳入 `characters/*/voice-pack.json` 与 `docs/voice-pack.md`。

---

## 2. 改了哪些文件

### 新增
| 文件 | 作用 |
|---|---|
| `apps/server/src/scene/detect.ts` | §1 纯函数 `detectSceneRequest(text, triggerPattern)` |
| `apps/server/src/scene/spec.ts` | §2 `parseSceneSpec` + zod schema（`SceneSpec` / `Rejected` / `Invalid`） |
| `apps/server/src/scene/prompt.ts` | §3 `composeScenePrompt`（参考图指令 + 场景 + 构图锁 + 画风锁） |
| `apps/server/src/scene/job.ts` | §4 `sceneJobReducer` + `admitSceneJob`（单任务 / 冷却 45s / 上限 5 次 / 90s 超时常量） |
| `apps/server/src/scene/runner.ts` | §2–§4 编排：扩写 → 拼提示词 → 两张并行生图 → 下发 `scene_status` |
| `apps/server/src/scene/writer.ts` | §2 真实 `SceneWriterPort`（复用 LLM 适配器，按 `LLM_PROVIDER`） |
| `apps/server/src/adapters/mock/mockSceneWriter.ts` | §2 Mock 查表（含「海」/「雨」/其它「随便换」3 条） |
| `apps/client/src/live/scene/status.ts` | §5 客户端 `scene_status` store（zustand） |
| `apps/server/scripts/smoke-scene.ts` | §6 真实冒烟 `pnpm smoke:scene` |
| `apps/server/test/scene.test.ts` | §6 单测（22） |
| `apps/server/test/sceneIntegration.test.ts` | §6 集成（6） |
| `apps/server/test/sceneRunner.test.ts` | §6 运行器真实路径测试（3，本次新增） |
| `apps/client/public/characters/yuna/test-scene-*.jpg`、`apps/client/public/characters/rin/test-scene-*.png` | §6 Mock 用的预置测试图（由现有背景复制） |

### 修改
- **协议** `packages/protocol/src/messages.ts`：新增 `scene_status` 消息 + `SceneStatusPayload`。
- **服务端**
  - `session.ts`：只加「换背景」旁路（检测命中 → admission → 后台 `runSceneJob` → 兜底 beat / `scene_notes`）；`sceneJob` / `sceneController` 会话字段；切频道 `abort sceneController`；打断**不**动它。
  - `index.ts`：注入 `sceneWriter`（Mock / 真实）与 `sceneImageGen`。
  - `ports.ts`：`SceneWriterPort` / `SceneWriteContext` / `LLMContext.sceneNotes`。
  - `characters/pack.ts`：`FALLBACK_CATEGORIES` 加 3 类；`pack.json` 加 `sceneLock`；`content.json` 加 `sceneTriggers`；`clientPublicRoot()` / `resolveClientAssetPath()`。
  - `prompts/renderPrompt.ts`：`scene_notes` 支持 nudge 与换背景叠加。
  - `adapters/media/imageGen.ts`：可选 `reference`（走 `POST /v1/images/edits`，multipart：`model`/`prompt`/`size`/`image`）+ 可选 `size`。
  - `test/pack.test.ts`：补三类兜底台词断言。
- **客户端**
  - `live/Live.tsx`：`SceneStatusBar`（桌面 + 手机两种布局）。
  - `live/StageRenderer.tsx`：`CrossfadeBackground`（本次新增，真实交叉淡入）。
  - `live/live.css`：状态条样式 + 交叉淡入 keyframes。
  - `live/uiText.ts`：`sceneTransition` / `sceneFailed` / `sceneReady`。
  - `core/connection.ts`：`scene_status` 直接进 `handleSceneStatus`（剧情层，不过 turnId 过滤）。
  - `state/reducer.ts`：`scene_status` 原样忽略（与 `media_ready`/`pong` 同）。
  - `core/controller.ts`：切频道时 `resetSceneStatus()`。
  - `view/useStageViewModel.ts`：暴露 `sceneStatus` / `sceneBackground`。
- **角色包**：`characters/{rin,yuna}/pack.json`（+`sceneLock`）、`content.json`（+`sceneTriggers`、+3 类兜底）、`voice-pack.json`（重生成）。
- **文档**：`docs/voice-pack.md`（重生成）。
- **e2e**：`e2e/live.spec.ts` 加 S6c 换背景用例。

---

## 3. 协议改动

新增一条下行消息（`serverMessageSchema`）：

```ts
sceneStatusPayloadSchema = z.object({
  jobId: z.string(),
  status: z.enum(["writing", "generating", "ready", "failed", "rejected", "busy"]),
  label: z.string().optional(),
  urls: z.object({ desktop: z.string(), mobile: z.string() }).optional(),
});
```

- 属于**剧情层旁路**（与 `media_ready` 一致）：客户端直接分发，不经过状态机 A 的 turnId 过滤，即：打断不会作废它（D27 / D34 的有意例外）。
- 未改任何既有消息与状态机语义。

---

## 4. 测试

- **单测/集成（本次全绿）**：`pnpm vitest run` → **75 文件 / 726 测试全通过**。
  - 其中 S6c 相关：`scene.test.ts` 22、`sceneIntegration.test.ts` 6、`sceneRunner.test.ts` 3、`pack.test.ts` 涉及新增字段。
- **typecheck**：`pnpm typecheck` 全绿（5 个 workspace 包）。
- **e2e**（Mock 模式，`E2E_SERVER_PORT=8987 E2E_CLIENT_PORT=5373`，端口当时空闲）：
  - S6c 换背景用例：`iphone-13` + `desktop` **2/2 通过**。
  - 全量 e2e：**27 passed / 17 skipped**（skipped 为既有的按项目跳过项）。
  - 截图：`e2e/out/live-scene-desktop.png`、`e2e/out/live-scene-mobile.png`。

### 已知不稳定（**非本批引入**）
`apps/server/test/director.property.test.ts` 的「500 次 × 50–200 beat」属性测试**偶发失败**：单独跑连续 5 次全过，全量并行跑偶发 1 次失败（fast-check 未固定 seed）。与本批场景代码无关，未改动它，如实记录供后续处理。

---

## 5. `smoke:scene` 怎么跑

```bash
pnpm smoke:scene
```

- 需要 `.env` 里：`DEEPSEEK_API_KEY`（或 `LLM_PROVIDER=commandcode` 用本地 `cmd`）、`IMAGE_API_KEY`、`IMAGE_BASE_URL`。
- 行为：真实扩写 1 次（`characters/yuna/scene.v1.md`，弹幕「换背景到海边吧」）→ 真实参考图生图 1 次（桌面 + 手机**并行**，走 `/v1/images/edits`）→ 打印耗时与 label（**不打印任何 Key**）。结果同时写入 `var/generated/smoke-scene-last.json`（`var/` 已 gitignore）。
- 缺 Key 时打印「跳过」并以 0 退出（不算失败）。
- **本次实测（官方 DeepSeek + `gpt-image-2.5-sunburst`）**：

  ```
  [smoke:scene] 角色=yuna（忧奈），LLM=deepseek，生图模型=gpt-image-2.5-sunburst
  [smoke:scene] 扩写 OK：label=「深夜海边」，耗时 1847ms
  [smoke:scene] note=观众把背景换成了深夜的海边，海风有点凉
  [smoke:scene] 参考图：desktop 329530 bytes，mobile 382888 bytes
  [smoke:scene] 生图 OK（并行两张）：44583ms
  [smoke:scene] 总耗时（扩写 + 生图）：46435ms
  SMOKE:SCENE OK
  ```

  即：真实链路**跑通**，扩写 ~1.8s、两张并行生图 ~44.6s，均在 §4 预算内（单张 60s / 总 90s）。参考图解析正确（读到的正是 `bg-desktop.jpg` / `bg-mobile.jpg` 的真实字节数）。

---

## 6. 歧义与处理

1. **`detectSceneRequest` 签名**：任务 §1 写作 `detectSceneRequest(text, pack)`；实现取的是第二个参数 `RegExp`（会话层传 `pack.sceneTriggerPattern`），功能等价、更易测。属轻微签名偏差，未改。
2. **「换到海边吧」不命中**：任务 §1 给的 `sceneTriggers` 正则原样（`换背景|…|带我去|…`）**不含**「换到海边吧」这种句式；因此 e2e 用「**换背景**到海边」触发（`scene.test.ts` 里也注明了这一点）。正则逐字未改（铁律：提示词/台词原样）。
3. **Mock 测试图扩展名**：任务 §6 举例 `test-scene-*.jpg`；夏凛的测试图实际是 `.png`（复制自 `b1_bg_main_*.png`，尺寸不同不便转 `jpg`）。为不改任务举例的忧奈资源，`mockSceneUrls` 按磁盘存在的扩展名自适应，两种都覆盖。
4. **90s 总超时的落点**：总超时在两张图 Promise 都结算后判断；单张卡死由 `imageTimeoutMs`（默认 60s）兜底。§4「90 秒 → failed」与 §6「生图超时」都被覆盖。
5. **`busy` 的 `jobId`**：冷却/超次数/已有任务时下发 `scene_status{status:"busy", jobId:""}`（无任务），协议允许空串。角色立即说 `scene_busy` 兜底。
6. **交叉淡入的判定口径**：真正的交叉淡入需要两层背景；e2e 用 `querySelector(".live-bg")`（第一层=旧层）判断，动画结束（1.2s）后该层更新为新图，故断言仍成立。
7. **不做的事**：未碰 live2d-pipeline / skills；未做任何余额/额度降级代码；未 commit。

---

## 7. 引用的决策
Q10、D27、D34、D38–D41（D41 为 S6c 本体的授权决策）。
