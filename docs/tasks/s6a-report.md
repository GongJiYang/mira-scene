# S6a 执行报告

> 执行者：Command Code（DeepSeek）。日期：2026-10-27。
> 任务：`docs/tasks/s6a.md`。按 §1 → §2 → §3 顺序完成，每项后跑 `pnpm test && pnpm typecheck`。
> 全程**未 commit**。

---

## 0. 结论速览

| 项 | 状态 |
|---|---|
| §1 忧奈 Live2D 预览 | ✅ 完成，浏览器实测可渲染（截图见 `e2e/out/yuna-preview.png`） |
| §2 Command Code LLM 适配器 | ✅ 完成，`pnpm smoke:real`（`LLM_PROVIDER=commandcode`）实跑通过 |
| §3 S5-fix | ✅ 完成，reducer 单测 + e2e 断言覆盖 |
| 测试 | `pnpm test` 530 passed、`pnpm typecheck` 通过、`pnpm smoke` OK、`pnpm e2e` 12 passed |

**一处必须裁定的冲突（铁律 1）**：§1.2 指定的 Cubism Core 下载 URL 当前提供 **Core 5.1.0**，
它与任务要求的「最新的 `5-r.*` tag」（= **5-r.5**）**不兼容**；与 **5-r.4** 匹配。
我把框架固定为 **5-r.4**，理由与实测证据见「歧义」一节。

---

## 1. 改了哪些文件

### 新增
- `tools/yuna-assets/build.sh` —— 忧奈资源构建脚本（可重复、源目录只读）。
- `apps/client/public/models/yuna/**` —— 构建产物：`yuna.moc3` / `yuna.model3.json` /
  `yuna.physics3.json` / `yuna.cdi3.json` / `textures/texture_00–03.png`。
- `apps/client/public/vendor/cubism/live2dcubismcore.min.js`、`LICENSE.md` —— Cubism Core 5.1.0。
- `apps/client/vendor/CubismWebFramework/**` —— CubismWebFramework **5-r.4**（去掉 `.git`，保留 LICENSE）。
- `apps/client/src/render/live2d/cubism/yunaRenderer.ts` —— 忧奈渲染外壳（命令式，无决策逻辑）。
- `apps/client/src/render/live2d/yunaParams.ts` —— 纯函数 `yunaParams` / `approach` / 参数常量表。
- `apps/client/src/preview/YunaPreview.tsx`、`preview.css` —— 预览页。
- `apps/client/src/types/live2dcubismcore.d.ts`、`cubism-shim.d.ts` —— 类型声明（见「类型隔离」）。
- `apps/server/src/adapters/commandcode/{commandCodeLlm,flattenMessages,parseCmdNdjson,preflight,status}.ts`。
- 测试：`apps/client/test/{yunaParams,s5fix}.test.ts`；
  `apps/server/test/commandcode{,Flatten,Parse,Config}.test.ts`；`e2e/yuna-preview.spec.ts`。

### 修改
- `apps/client/src/main.tsx` —— 只加预览路由分支（`?preview=yuna`）。
- `apps/client/src/state/storyMedia.ts`、`src/core/storyMediaLink.ts`、`src/core/connection.ts`、
  `src/view/useStageViewModel.ts`、`src/view/Stage.tsx` —— §3 S5-fix。
- `apps/client/index.html` —— 本地加载 Cubism Core 的 `<script>`。
- `apps/client/vite.config.ts`、`tsconfig.json` —— `@cubism` 别名（接入框架源码）。
- `apps/server/src/config.ts`、`src/index.ts`、`scripts/smoke-real.ts`、`.env.example` —— §2 provider 选择。
- 测试字面值：`test/interruptMatrix.property.test.ts`、`storyMedia.test.ts`、`storyMediaImageFailed.test.ts`、
  `viewModelAdditions.test.ts`、`e2e/mobile.spec.ts`（只改字面值 / 补断言，未改意图）。

### 未触碰（另一个会话的改动）
`skills/live2d-auto/*`、`tools/live2d-pipeline/*`、`docs/architecture/decisions.md`、`PROGRESS.md`
在本次会话开始前就已是修改状态，我一行未动。

---

## 2. §1 忧奈 Live2D 预览

### 2.1 资源体积（§1.1）
- **改动前 48.7 MiB → 改动后 7.6 MiB**（`apps/client/public/models/yuna`，7929856 字节）。
- 只拷贝：`漠.moc3`、`漠.model3.json`、`漠.physics3.json`、`漠.cdi3.json`、贴图；全部改 ASCII 名；
  `yuna.model3.json` 里的引用同步改写；贴图只出 2048×2048（`texture_03` 64×64 原样）；
  水印参数 `Param1–Param10` 保持原样。

### 2.2 运行时（§1.2）
- **Cubism Core 5.1.0**（`csmGetVersion() = 0x05010000`）从任务指定 URL 下载，本地加载。
- 框架：**CubismWebFramework `5-r.4`**（2025-05-15）。**理由见「歧义」**。
- 渲染外壳每帧：写参数 → EyeBlink → 物理 → update → draw。决策逻辑全部在 `yunaParams` 纯函数里。

### 2.3 渲染外壳踩到的三个坑（都已修正，供后续参考）
1. 必须调 `renderer.startUp(gl)`，否则 `doDrawModel` 直接 return（画布全空、无报错）。
2. 必须逐个 `renderer.bindTexture(index, texture)`，否则没有可采样的贴图。
3. **参数 id 必须取自 `CubismFramework.getIdManager()`**，不能 `new CubismIdManager()`——
   模型内部按对象同一性匹配参数 id，用别的实例拿到的 id 会静默匹配失败（参数写不进去，
   情绪/呼吸/视线全部不生效）。这条最初表现为「模型能显示但所有参数不变」，已修正。
- WebGL 上下文用 `preserveDrawingBuffer: true`，让 e2e 的 `readPixels`/截图可靠。

### 2.4 情绪参数正负方向实测结论（§1.3、报告要求）
截图存于 `e2e/out/emotion-{calm,guarded,sad,warm}.png`。

| 情绪 | 参数 | 实测结果 |
|---|---|---|
| calm | 不叠加 | 模型默认脸（本就半眯、下垂视线，「冷漠/厌世」气质） |
| guarded | `EyeL/ROpen` 上限 0.6、`BrowLY/RY=-0.4` | ✅ 眼皮明显更合、眉压低，一脸防备 |
| sad | `BrowLAngle=-1`、`BrowRAngle=+1`、`BrowLY/RY=-0.3`、`MouthForm=-0.6` | ✅ 得到**内高外低的八字眉** + 小撇嘴 |
| warm | `MouthForm=+0.7`、`EyeL/RSmile=0.6`、`Shy=1` | ✅ 嘴角上扬 + 两颊红晕 + 笑眼 |

- **视线 X 取反**确认：`ParamEyeBallX` 是反向映射（REPORT §4），`yunaParams` 里统一取反。
- **眼睛开合**：模型 `ParamEyeLOpen` 区间实测为 **[0, 2]、默认 1**（即默认就是半眯）。
  `applyEyeOpen` 把 `blinkOpen∈[0,1]` 放大到 `EYE_OPEN_MAX=1.9`，让睁眼可见（默认值 1 会一直半眯）。
  guarded 再压到 0.6。该函数是纯函数，外壳在 EyeBlink 之后调用，满足「眨眼值最终经过上限」。

### 2.5 预览页（§1.4）
- `/?preview=yuna` 渲染预览页，否则照旧渲染 App。
- 左画布（胸像到大腿、居中）+ 右调试面板（phase / emotion / mouth + 自动说话开关 / 手动眨眼按钮 + FPS + 贴图尺寸）。
- 模型加载失败显示错误卡片「模型加载失败：<错误>」，不回退夏凛。

---

## 3. §2 Command Code LLM 适配器

- 实现现有 `LLMPort.streamBeats`，**核心与会话层一行未改**。
- 纯函数：`flattenMessages`（拼 prompt + 前缀声明）、`parseCmdNdjson`（增量解析 NDJSON，
  坏行忽略、`result.subtype!=="success"` 与错误事件报错）。
- 文本再交给现有 `parseBeatLines` 产出 beat（与 DeepSeek 同一路径）。
- 外壳：注入 `spawn`（默认 `node:child_process`），
  `cmd -p <prompt> -m <model> --effort off --skip-onboarding --trust --no-session --no-skills --max-turns 1 --output-format json`，
  stdin 关闭，cwd 用空的临时目录。模型默认 `deepseek/deepseek-v4-flash`，`COMMANDCODE_MODEL` 覆盖。
- 配置：`LLM_PROVIDER=commandcode|deepseek`（默认 deepseek）写入 `config.ts` + `.env.example`。
- 契约：`real + commandcode` 时启动检查 `cmd` 可执行且 `cmd status` 已登录，不满足启动报错退出；
  非零退出 / result 非 success → 抛错走 `turn_failed`；AbortSignal → 立刻 kill、迭代器结束；
  日志沿用 logger（`prompt_version` / 耗时 / 数字 usage）。
- `apps/server/scripts/smoke-real.ts`：按 `LLM_PROVIDER` 走对应适配器，commandcode 时不要求 DeepSeek Key。

### 实测首句延迟（`pnpm smoke:real`，`LLM_PROVIDER=commandcode`）
| 轮次 | LLM 首句 | TTS 首包 | 开始播放 |
|---|---|---|---|
| 1 | 3428 ms | 4440 ms | 4441 ms |
| 2 | 3275 ms | 4607 ms | 4607 ms |

- 结论：每轮启动一次 `cmd`，**LLM 首句 ≈ 3.3 s**，与 D39 的预估（3.0–3.5 s）一致。
- `SMOKE:REAL OK`（Fish TTS 正常，无降级）。

---

## 4. §3 S5-fix

### 4.1 ending 不再出现空白相纸
- 原因：视频 REQUEST 也走照片槽位的 `developing` → `photoLayer` 返回空白相纸。
- 修法：`StoryMediaState` 新增**独立视频槽位** `video`；REQUEST 带 `kind`，视频请求只写视频槽位，
  照片槽位保持不动。空白相纸只由照片槽位的 `developing/ready` 触发，视频不再出现相纸。

### 4.2 reveal 照片保留
- 原因：视频 READY 覆盖了 C 里的 `media`，reveal 照片消失。
- 修法：视频事件按 `kinds[storyEventId]==="video"` 路由到视频槽位，照片槽位完全不受影响。
  `Stage.tsx` 从 `vm.storyMedia.video` 驱动视频；打断时照片保留、视频结束（D37）语义不变。

### 4.3 测试
- reducer 单测 `apps/client/test/s5fix.test.ts`（6 条）覆盖两条。
- e2e `e2e/mobile.spec.ts` 视频用例补断言：视频播放期间与打断后 `stage-photo` 仍在。

---

## 5. 测试数

- `pnpm test`：**530 passed**（56 个文件）。新增：`yunaParams`(19) / `s5fix`(6) /
  `commandcode`(8) / `commandcodeParse`(8) / `commandcodeFlatten`(3) / `commandcodeConfig`(7)。
- `pnpm typecheck`：通过（4 个 workspace 项目）。
- `pnpm smoke`：`SMOKE OK`。
- `pnpm e2e`：**12 passed / 10 skipped**（skipped 是「只在某个 project 跑一次」的设计跳过）。
- `pnpm smoke:real`（commandcode）：实跑通过。

---

## 6. 遇到的歧义与处理（请 Claude 裁定）

### 6.1【重要·冲突】Cubism Core 版本与框架版本不匹配
- **现象**：任务指定 Core 下载 URL（`cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`）
  实测提供的是 **Core 5.1.0**。它与任务要求的「最新的 `5-r.*` tag」（`5-r.5`）**不兼容**：
  - Core 5.1.0 的 `Version.csmGetMocVersion` 是 **双参数** `(moc, mocBytes)`；`5-r.5` 传 **单参数**
    → `TypeError: Cannot read properties of undefined (reading 'byteLength')`（已实测）。
  - Core 5.1.0 的 `Model` **没有 `offscreens`**；`5-r.5` 的 `CubismModel.initialize()` 读 `offscreens.opacities`
    → 报错（已实测）。
  - 另外 `5-r.5` 用 `moc.createModel()`，Core 5.1.0 改成了 `Model.fromMoc(moc)`。
- **核对**：`5-r.4`（2025-05-15）与 Core 5.1.0 **完全匹配**：`csmGetMocVersion(moc, mocBytes)` 双参数、
  用 `Model.fromMoc`、无 `offscreens`。实跑加载、渲染、参数全部正常。
- **处理**：把 `apps/client/vendor/CubismWebFramework` 固定为 **`5-r.4`**（**未改框架源码**）。
  这是唯一能同时满足「Core 用指定 URL」+「不改框架源码」的配对。
- **请裁定**：是否接受框架用 `5-r.4`？若必须 `5-r.5`，则需要换成与它匹配的 Core 5.0.x
  （该 Core 仅随 SDK 压缩包分发、CDN 无版本化地址，需要用户提供文件）。

### 6.2 §1.3 眼睛开合的语义
- 模型 `ParamEyeLOpen` 区间是 **[0, 2]、默认 1**（默认即半眯）。任务后置条件写「∈[0,1.9]」。
- 我按「`blinkOpen∈[0,1]` 归一化 → 放大到 `EYE_OPEN_MAX=1.9`」处理：默认睁眼可见，
  guarded 上限 0.6。若期望「1 = 模型默认半眯」，可把 `EYE_OPEN_MAX` 调回 1（常量集中，一处改）。

### 6.3 `Page style` 的「呼吸」幅度
- 任务要求 `ParamBodyAngleY` 幅度 ≤ 2、`ParamAngleY` 幅度 ≤ 1.5，周期约 3.5 s，speaking 减半。
  已按此实现（正弦，`tSec` 驱动）。实测幅度肉眼可辨但不夸张。

### 6.4 预览页构图参数
- 模型画布 5775×8000，但角色画在**上方偏左**，直接用官方 `setWidth` 居中会偏。我加了
  `MODEL_WIDTH_UNITS / VIEW_OFFSET_X / VIEW_OFFSET_Y` 三个常量（集中，便于后续调），
  实测得到「胸像到大腿、水平居中」的构图。

### 6.5 一个与本批无关的既有 flaky 测试
- `apps/server/test/director.property.test.ts`（500 次属性测试）偶发超时失败，单独重跑必过，
  与本批改动无关（未碰 director）。全量重跑 530/530 通过。

---

## 7. 未做（按任务「先不做」清单）
模型自带 14 个按键表情（exp3）、流泪动作、4096 贴图 / 压缩纹理、角色包、直播间 UI、
忧奈音色与按角色分开的 Mock 语音 —— 均留待后续批次。

---

# fix1（`docs/tasks/s6a-fix1.md` 执行报告）

> 执行者：Command Code（DeepSeek）。日期：2026-10-27。
> 铁律继续有效：冲突停下报告、Key 不打印、**未 commit**、不碰 live2d-pipeline / skills。

## fix1-0 结论速览

| 项 | 状态 |
|---|---|
| §1 切情绪旧参数残留 | ✅ 修（`yunaParams` 输出恒含情绪键并集，未用到的给 0） |
| §2 自动眨眼被覆盖 | ✅ 修（外壳读回 EyeBlink 值 × 手动值 → `combineBlink` → `applyEyeOpen`；`update()` 每帧一次） |
| §3 情绪切换无平滑 | ✅ 修（纯函数 `approachParams`，外壳只平滑情绪键，约 0.25 s 到位） |
| §4 单一出处 | ✅ 达成意图（见 fix1-4，位置与任务文字不符，已记录） |
| §5 sad 不够明显 | ⚠️ 尽力而为（见 fix1-5：受模型本身限制，接近上限） |
| 测试 | `pnpm test` 539 passed、`pnpm typecheck` 通过、`pnpm e2e` 13 passed / 11 skipped |

## fix1-1 改了哪些文件

- `apps/client/src/render/live2d/yunaParams.ts` —— §1/§2/§3/§4/§5 的纯函数与常量。
- `apps/client/src/render/live2d/params.ts` —— 把私有 `MOUTH_OPEN` 改为 `export`（§4 单一出处）。
- `apps/client/src/render/live2d/cubism/yunaRenderer.ts` —— §2 读回 EyeBlink 值 + `update()` 只一次；
  §3 每帧 `approachParams` 平滑情绪键；新增只读 `eyeOpen()`。
- `apps/client/src/render/live2d/cubism/` 与 `apps/client/src/types/cubism-shim.d.ts` —— shim 补
  `CubismModel.getParameterValueById`（读回 EyeBlink 值所需）。
- `apps/client/src/preview/YunaPreview.tsx` —— 新 `YunaFrame` 契约（params/emotion/manualBlink）、
  `data-eye-open` 只读调试值、面板显示 eyeOpen。
- `apps/client/test/yunaParams.test.ts` —— §1 属性测试 + `approachParams` / `combineBlink` 单测 + sad 新值。
- `e2e/yuna-preview.spec.ts` —— §5 情绪截图（`e2e/out/emotion-*.png`）+ §2 自动眨眼断言。
- `docs/tasks/s6a-report.md` —— 本「fix1」节。

## fix1-2 逐条改法

### §1 空值残留 —— 纯函数里解决
- 新增 `EMOTION_KEYS`（`EMOTION_PARAMS` 所有情绪键的并集）。
- `yunaParams` 先把 `EMOTION_KEYS` 全部铺 0，再用当前情绪覆盖。输出键集合**恒定**，
  外壳无需重置参数，sad → calm 后 `ParamBrowLAngle/…`、`ParamBrowLY/RY`、`ParamEyeLSmile/RSmile`、
  `ParamShy` 全部回 0（模型默认）。
- 测试：fast-check 属性「任意两组输入 → 输出键集合完全相同」；另断言 calm 的 `EMOTION_KEYS` 全 0。

### §2 自动眨眼 —— 外壳只读写，决策在纯函数
- 新 `combineBlink(auto, manual) = clamp(auto,0,1) * clamp(manual,0,1)`。
- 外壳顺序改为 **写参数 → EyeBlink → 读回它写的 `ParamEyeLOpen`（0–1）→ `combineBlink` ×
  手动值 → `applyEyeOpen`（情绪上限）→ 写回 → 物理 → `update()` → draw**。
- `model.update()` 每帧**只调一次**（旧实现 `step()` + `setEyeOpen()` 各一次）。
- 预览页不再用常量 1 覆盖：手动眨眼改为 `manualBlink` 值（0=闭、1=不干预），
  自动眨眼（EyeBlink）与手动值相乘，二者都生效。
- 测试：`combineBlink` 单测（0×1=0、0.5×0.5=0.25、越界夹紧、NaN→0）；
  e2e「6 秒内 `data-eye-open` 至少一次 < 0.3」——预览页每秒采样 `eyeOpen()` 的**滑动最小值**写入
  `data-eye-open`（避免每帧 React 重渲染），e2e 轮询该属性。

### §3 情绪平滑 —— 纯函数 `approachParams`
- 新 `approachParams(current, target, dt)`：只遍历 `target` 的键，逐键 `approach`；键集合 = target。
- 外壳保存上一帧情绪键值，每帧 `approachParams(prev, 本帧情绪键, alpha)`，`alpha = min(1, dt / 0.25)`
  （约 0.25 s 到位）。**只平滑情绪键**：呼吸 / 口型 / 视线直接取目标值。
- 测试：`approachParams` 单测（dt=0 不变、dt=1 直达、键集合 = target、current 缺键不跳变）。

### §4 单一出处
- `yunaParams.ts` 里重复定义的 `MOUTH_OPEN` 已删除，改为 `import { MOUTH_OPEN } from "./params"`
  并原样 `export`（保持旧引用可用）。

### §5 sad 调参
- 新值见下表（其余情绪未动，guarded 眼睛上限 0.6 原样保留）。

## fix1-4【歧义·冲突】§4 说的 `performance.ts` 里没有 `MOUTH_OPEN`
- **现象**：`docs/tasks/s6a.md` §1.3 与 `s6a-fix1.md` §4 都写「沿用 / 从 `state/performance.ts` 的
  `MOUTH_OPEN`」。但实测 `apps/client/src/state/performance.ts` **没有** `MOUTH_OPEN`——
  它实际定义在 `apps/client/src/render/live2d/params.ts`（且是私有 const）。
- **处理**：按铁律 1 停下记录。§4 的**意图**（消除重复、单一出处）明确，我把它落在**实际所在**的
  `params.ts`：改为 `export`，`yunaParams.ts` 从 `"./params"` 导入并原样 `export`。
  行为与数值不变（`closed/small/open → 0 / 0.5 / 1`）。
- **请裁定**：是否接受「单一出处 = `params.ts`」？还是要把 `MOUTH_OPEN` 迁到 `state/performance.ts`
  再从那里导入（会牵动 `params.ts` 的引用）？

## fix1-5【重要·模型限制】sad 无法「明显」区分，已达模型上限
- **现象**：`s6a-fix1` §5 要求「让 sad 与 calm 的脸部截图**肉眼可区分**」。我按最大舒适区间
  调参后逐张放大核对，结论：**该模型的 sad 信号天然很弱**，原因是结构性的，不是参数问题：
  1. **眉毛被刘海遮住**——肉眼只能看到眉峰内侧一点点。`ParamBrowLAngle/RAngle`（八字眉）几乎看不见，
     而「八字眉」本是 sad 最主要的信号（S6a 也承认 `5-r.4` 下眉毛是主信号）。
  2. **`ParamMouthForm` 视觉影响极小**——实测 ±1 的嘴角变化都几乎看不出（`+1` 和 `-1` 都是「小点嘴」）。
  3. 因此唯一**肉眼可见**的杠杆是**眼睛开合**（`ParamEyeLOpen/ROpen`）。
- **处理**（在授权范围内做到上限）：
  - `ParamBrowLAngle=-1` / `ParamBrowRAngle=+1`（八字眉方向，保留）；
  - `ParamBrowLY/RY` **-0.3 → -0.8**（眉压低，尽量露出可见的「蹙」）；
  - `ParamMouthForm` **-0.6 → -1**（嘴角下撇到底）；
  - 眼睛上限 `EMOTION_EYE_MAX.sad = 0.55`（新增，`ParamEyeLOpen/ROpen` 从常态 1.9 压到 0.55）。
- **实测**（放大脸部裁剪人工核对，2× deviceScaleFactor）：
  - calm：眼睛覆盖虹膜 ≈ 40–50%（半眯），五官平。
  - sad：眼睛覆盖虹膜 ≈ **70–80%**（重睑下垂），读作「沮丧 / 蔫」。对 calm 的差异**肉眼可见**
    （眼皮开合是主差异）。
  - 视觉判定原话：「clearly NOT neutral or cheerful；sad/glum 占主导，但更偏 subdue 而非痛哭」。
  - ⇒ **与 calm 可区分（靠眼睛），但「纯粹的悲伤」气质被模型压制**。
- **请裁定**：接受「sad = 靠更垂的眼皮 + 下压眉 + 撇嘴角表达，肉眼可与 calm 区分」？
  若要求「一眼看出在哭 / 更强烈的悲伤」，超出当前模型能力（无流泪动作、眉毛被刘海遮挡），
  需要后续批次加**流泪动作**或换**可见眉毛的贴图/表情**，不在本次授权范围。
- 截图已更新：`e2e/out/emotion-{calm,guarded,sad,warm}.png`，由 `e2e/yuna-preview.spec.ts` 生成。

## fix1-6 测试数

- `pnpm test`：**539 passed**（56 文件）。`yunaParams.test.ts` 19 → **28**（+`approachParams`、+`combineBlink`、
  +§1 键集合属性、+sad 新值）。
- `pnpm typecheck`：通过。
- `pnpm e2e`：**13 passed / 11 skipped**；其中预览页新增 1 条（自动眨眼 < 0.3），原 1 条扩展为
  含情绪截图。
- 另：`apps/server/test/director.property.test.ts` 仍是既有 flaky（首跑偶发失败、重跑必过，见 §6.5），
  与本批无关。

## fix1-7 未做 / 边界

- 未改 `guarded`（眼睛上限 0.6 原样）、未改 `warm`（原样）。
- 未引入流泪动作 / 换贴图（超出授权范围，见 fix1-5）。
- 未删除任何调试 spec（本批未新增 `dbg`/`probe` 一类；`e2e/mobile.spec.ts` 里的 `probe` 是剧情事件名，非调试文件）。
- **未 commit**。

---

# fix2（`docs/tasks/s6a-fix2.md` 执行报告）

> 执行者：Command Code（DeepSeek）。日期：2026-10-27。
> 铁律继续有效：冲突停下报告、Key 不打印、**未 commit**、不碰 live2d-pipeline / skills。
> 授权范围：`apps/client/src/render/live2d/cubism/**`、`apps/client/src/preview/**`、`e2e/yuna-preview.spec.ts`、追加本报告。

## fix2-0 结论速览

| 项 | 状态 |
|---|---|
| §1 画布填满左侧、随窗口自适应（ResizeObserver + DPR 上限 2） | ✅ 完成 |
| §2 人物完整显示、高度约 92%、水平居中 | ✅ 完成（桌面实测 ~91%，四边均有余量） |
| §3 构图常量集中 + 纯函数 `fitModel` + 单测（任意宽高比不出画） | ✅ 完成 |
| §4 用模型可见区域包围盒（`MODEL_BOUNDS`，注明测量方法） | ✅ 完成（不再用整张 5775×8000 画布） |
| §5 e2e：桌面 / 手机各一张截图 + 四边 4px 条带无像素 | ✅ 完成 |
| 测试 | `pnpm test` 547 passed、`pnpm typecheck` 通过、`pnpm e2e` 15 passed / 13 skipped |

## fix2-1 改了哪些文件

- `apps/client/src/render/live2d/cubism/fit.ts` —— **新增**：`MODEL_BOUNDS`、`FIT_PRESETS`（desktop / mobile）、
  `presetFor`、纯函数 `fitModel`。
- `apps/client/src/render/live2d/cubism/yunaRenderer.ts` —— 用 `fitModel` 计算模型矩阵（删掉旧的
  `MODEL_WIDTH_UNITS / VIEW_OFFSET_X / VIEW_OFFSET_Y` 猜测常量）；`resize` 支持 `devicePixelRatio`
  （上限 2）；分离「物理像素（视口）/ CSS 像素（构图与宽高比）」；修正竖画布的投影变形。
- `apps/client/src/preview/YunaPreview.tsx` —— canvas 尺寸跟随容器（ResizeObserver + DPR），去掉 2:3 固定卡片。
- `apps/client/src/preview/preview.css` —— `.preview-root` 改 `height: 100dvh`、canvas `width/height: 100%`；
  窄屏纵向堆叠时画布占主高度。
- `apps/client/src/types/cubism-shim.d.ts` —— shim 补 `CubismMatrix44.translate`、`CubismModelMatrix.setHeight`。
- `apps/client/test/yunaFit.test.ts` —— **新增** 8 条单测（含 fast-check 属性）。
- `e2e/yuna-preview.spec.ts` —— 新增 fix2 构图用例（桌面 + 手机）；并放宽自动眨眼等待窗（见 fix2-5）。
- `docs/tasks/s6a-report.md` —— 本「fix2」节。

## fix2-2 `MODEL_BOUNDS` 的测量方法与数值

**测量方法**（离线实测一次）：
1. 起 `pnpm dev`（mock），加载 `/?preview=yuna`，等模型就绪（画布出现）。
2. 在页面里逐 drawable 读 `model.getDrawableVertexPositions(i)`（**模型坐标，原点 = 模型画布中心**），
   跳过 `model.getDrawableOpacity(i) < 0.01` 的不可见 drawable。
3. 对可见顶点取 min/max，得静息帧的包围盒。

**实测原始值**（模型坐标）：

```
left = -0.3391   right  =  0.3786
bottom = -0.6794 top    =  0.6804
```

- 模型画布（`getCanvasWidth × getCanvasHeight`）是 **1.0 × 1.38528**（不是 5775×8000——5775/8000 是
  原始像素，Cubism Core 按 `PixelsPerUnit` 换算成上面这组模型单位）。
- 角色可见内容只占画布中间一条（画布两侧留白很多），所以按整张画布构图会把人缩得很小；
  这里按可见区域构图。

**关键坑（一度算错，已修正）**：`draw()` 里模型矩阵是直接 `scale(s)` + `translate(x,y)` 作用在
`getDrawableVertexPositions` 的坐标上，**不要再乘 `2/canvasHeight` 之类的换算系数**。我第一版多乘了
1.44375，导致人物只占 63% 高；改回原始模型坐标后即为 92%。

## fix2-3 两组构图常量（`FIT_PRESETS`）

```ts
desktop: { heightRatio: 0.92, offsetXRatio: 0, offsetYRatio: 0 }   // 宽画布：高 92%，水平居中
mobile:  { heightRatio: 0.92, offsetXRatio: 0, offsetYRatio: 0 }   // 窄画布：同样 92%（放不下则按宽度收紧）
```

- 缩放、X/Y 偏移**只有这一处**（§3）。
- 预设选择：`presetFor(canvasW)`，`< 720px`（`MOBILE_MAX_WIDTH`，与预览页 CSS 断点一致）→ `mobile`。
- 桌面实测：人物高 = 画布高 **~91%**，top 余量 ~4.4%、bottom ~4.1%、左右各 ~31%，
  **四边都不碰边**。
- 手机实测：人物高 ~90%，四边余量 top ~5%、bottom ~4%，四边不碰边。

## fix2-4 顺带修的一个投影 bug（否则竖画布会被压扁）

旧 `draw()` 的投影在竖画布（`W < H`）时用 `scale(1.0, W/H)`，把归一化画布在 Y 方向压扁，
导致人物只占 69% 高。归一化画布（宽 `2*W/H`、高 2.0、居中）映射到 NDC 只需 **X 方向 `H/W`**
（`projection.scale(viewportH / viewportW, 1.0)`），横竖画布一致、像素不变形。

## fix2-5 自动眨眼 e2e 的不稳定（一并处理）

fix1 的自动眨眼用例等 8 秒，但框架 `CubismEyeBlink` 的随机间隔是 `userTime + r*(2*4-1)`，
即 **1–7 秒**；8 秒窗口偶发覆盖不到一次眨眼（本次跑就出现 `minSeen = 1` 的失败）。
已把窗口放宽到 **12 秒**、轮询 **200ms**。判定意图不变（仍是「至少闭眼一次 < 0.3」），只改了等待窗口。

## fix2-6【歧义·需裁定】「不被裁掉」与「模型本身没有腿」

- `s6a-fix2` §2 要求「头顶的耳朵到画面底部的腿都不被裁掉」。实测：**该模型的可绘制内容本身就止于大腿**
  ——最低可见顶点在 `y = -0.6794`，而模型画布底在 `y = -0.6926`（差 ~1.3%，是贴图透明边距）。
  也就是说，模型里根本没有小腿 / 脚，`/?preview=yuna` 下不论怎么构图都不可能显示「腿」。
- 这与 S6a §1.4 原本的「胸像到大腿」描述一致，`emotion-*.png` / 旧的 `yuna-preview.png` 也都是到
  大腿为止。
- **我的处理**：按「把模型**全部可见内容**放进画布、四边都不碰边」构图（即模型能显示的都被完整显示），
  实测四边余量充足、e2e 断言四边 4px 条带无像素通过。人物**没有被画布裁掉**；只是这个资源的
  「腿」本来就不存在。
- **请裁定**：是否接受「『人物完整显示』= 显示该模型全部可见内容（到腿根为止），而不是要求显示不存在的腿」？
  若必须显示到脚，需要换/补一个含下半身的模型，超出本次授权范围。

## fix2-7 测试数

- `pnpm test`：**547 passed**（57 文件）。新增 `apps/client/test/yunaFit.test.ts` **8 条**：
  `presetFor` 1 条；`fitModel` 单测 4 条（92% 高 + 居中、四角不出画、窄画布按宽收紧、非法尺寸不产生 NaN）；
  fast-check 属性 3 条（**任意画布宽高比四角都在画布内**、可见高 = `heightRatio*2`（除宽度受限）、
  对称包围盒映射后中心在原点）。
- `pnpm typecheck`：通过（4 个 workspace 项目）。
- `pnpm e2e`：**15 passed / 13 skipped**；预览页新增 2 条（桌面 / 手机各一条构图用例），
  生成 `e2e/out/yuna-fit-{desktop,mobile}.png`。
- 另：`apps/server/test/director.property.test.ts` 仍是既有 flaky（首跑偶发超时、单跑/重跑必过，
  见 §6.5 与 fix1-6），与本批无关。

## fix2-8 未做 / 边界

- 未改模型资源、未补下半身美术（超出授权范围，见 fix2-6）。
- 未删除任何调试文件；本轮用于离线测量 `MODEL_BOUNDS` 的临时脚本跑完即删，**仓库内没有留下**
  `dbg`/`probe`/`measure` 一类文件（`e2e/` 下只有 `stage` / `mobile` / `yuna-preview` 三个 spec）。
- **未 commit**。
