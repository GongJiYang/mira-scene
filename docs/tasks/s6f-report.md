# S6f 报告：隐藏夏凛 + 忧奈四态动作

基线分支：`s6f-yuna-states`（worktree `/Users/gjy/mira-wt-s6f`）。**未 commit**，所有改动留在工作区。
执行说明：上一个执行会话中途异常退出，本次接手核对其已完成的部分（代码改动 + 单测已就绪），补齐未完成的验证（typecheck / e2e / smoke:real）与本报告。未推倒重来。
全程未打印、未写入任何 Key；Key 只从仓库根 `.env` 读取（`smoke:real` 用，e2e 与单测强制 `PROVIDER_MODE=mock`，不发真实网络请求）。未修改 `/Users/gjy/mira-scene` 与 `/Users/gjy/mira-wt-s6c`；`/Users/gjy/tools/models/yuna` 全程只读。未用读文件工具打开任何图片（截图只落盘，留给 Claude 看）。

## 0. 验收结果

| 命令 | 结果 |
|---|---|
| `pnpm test` | ✅ **72 个文件 / 718 tests passed** |
| `pnpm typecheck` | ✅ 5 个 workspace 全部 Done |
| `pnpm e2e e2e/s6f.spec.ts` | ✅ **4 passed**（iphone-13 + desktop 各 2） |
| `pnpm e2e e2e/live.spec.ts` | ✅ 6 passed / 2 skipped（skip 为原有标记） |
| `pnpm smoke:real` | ✅ `SMOKE:REAL OK`（详见 §5） |

四态截图（`e2e/out/`，未查看，留给 Claude）：

```
e2e/out/s6f-idle.png        1071027 B
e2e/out/s6f-listening.png   1070982 B
e2e/out/s6f-thinking.png    1070982 B
e2e/out/s6f-speaking.png    1074394 B
```

**端口冲突说明（铁律§冲突停下写进报告）**：任务指定 `E2E_SERVER_PORT=8987 E2E_CLIENT_PORT=5373`，但这两个端口当时被 S6c worktree（`/Users/gjy/mira-wt-s6c`，进程 73446 / 73477）的 dev server 占用。按「不许碰 s6c」的约束，未杀其进程，改用空闲端口 `E2E_SERVER_PORT=8988 E2E_CLIENT_PORT=5374` 跑 e2e。`playwright.config.ts` 本身支持用环境变量覆盖端口（S6d §3 引入），因此命令形式与任务要求一致，仅端口号不同。

## 1. 改动的文件

### §1 隐藏夏凛

- `characters/rin/pack.json`：加 `"hidden": true`（素材、台词、测试数据全保留）。
- `apps/server/src/characters/pack.ts`：
  - `packFileSchema` 加可选 `hidden: boolean`（缺省 false）；`Pack` 类型加 `hidden: boolean`，`parsePack` 落 `hidden ?? false`；
  - `loadPacks` 按目录名排序遍历，保证「第一个未隐藏角色」顺序确定；
  - 删掉写死的 `DEFAULT_CHARACTER_ID = "rin"`，改为 `defaultCharacterId(packs)`（第一个未隐藏角色，现在是 `yuna`；全隐藏时抛错）。
- `apps/server/src/session.ts`：缺省角色用 `defaultCharacterId(deps.packs)`；连接请求的角色**未知或隐藏** → 按现有 `unknown_character` 处理并关闭会话，不回退。
- `apps/server/src/index.ts`：真实模式启动校验 `fishVoiceIdEnv` 时 `if (pack.hidden) continue`——隐藏角色不做必填校验（`FISH_VOICE_ID` 为空不再让启动失败）。
- `apps/server/scripts/smoke-real.ts`：`pickEnv` 带上 `FISH_VOICE_ID_YUNA`（存在才注入）；脚本本身 `send("hello", {})` 走缺省角色，自动只跑未隐藏角色。
- `apps/server/scripts/record-voices.ts`：缺省角色改走 `defaultCharacterId(packs)`。
- `apps/client/src/live/characters.ts`：`ClientCharacter` 加可选 `hidden`；rin 标 `hidden: true`；导出 `VISIBLE_CHARACTERS = CLIENT_CHARACTERS.filter(!hidden)`；`DEFAULT_CHANNEL_ID` / `characterOrDefault` 改用 `VISIBLE_CHARACTERS[0]`。
- `apps/client/src/live/Live.tsx`：桌面频道栏与手机上下滑 / 切换按钮全部改用 `VISIBLE_CHARACTERS`（只剩忧奈一项；单频道时切换栏保留单项、点击仍是忧奈，布局不留空）。
- `e2e/live.spec.ts`：「切换频道」用例改为「单频道下切换按钮不破坏当前频道」；「夏凛频道舞台」用例改为「默认频道（忧奈）舞台已渲染」。没有删测试。
- `apps/server/test/helpers/pack.ts`：新增 `testPacksWithRinVisible()`（显式加载隐藏包：rin 的 `hidden` 覆盖为 false）与 `testPacksYunaOnly()`。
- `apps/server/test/characterPacks.test.ts`：缺省角色断言改为 yuna；新增「隐藏角色 rin → unknown_character」「显式加载隐藏包后 rin 可连接」两条；依赖 rin 的旧用例改用 `testPacksWithRinVisible()`。
- 其余服务端测试（`fallback / faults / integration / media / nudge / pack / session / sessionQuota / ttsVoice`）：缺省角色从 rin 变为 yuna 后的断言对齐（主要是缺省 hello 后的台词汇 / 角色 id），未删用例。

### §2 忧奈四态动作（纯函数出参数）

- `apps/client/src/render/live2d/yunaParams.ts`：扩展 `YunaParamInput`（`phaseSinceSec / idleSinceSec / firstSpokeSinceSec / silentAction / seed`），新增常量表与纯函数（明细见 §2 参数表）。视线 / 转头仍必经 `params.ts` 的 `clampView()`（D36）；输出统一过 `clampParam` 落舒适区。
- `apps/client/src/live/StageRenderer.tsx`：`Live2dStage` 加 `clockRef`（phaseSince / idleSince / firstSpokeAt / seed），phase 变化时重置、idle 进相时换新 seed（`Math.random()`，调用方传种子，纯函数可测）；把 5 个新输入喂给 `yunaParams()`。
- `apps/client/src/core/recorder.ts`：`Recorder` 加 `level(): number`——`AudioContext` 懒建、`MediaStreamSource → AnalyserNode(fftSize=512)`，`getFloatTimeDomainData` + `rmsFromTimeDomain`（复用 `core/audioLevel.ts`）得 RMS 0–1；停止录音时 disconnect。
- `apps/client/src/core/controller.ts`：导出 `micInputLevel()` 供 UI 读取。
- `apps/client/src/live/Live.tsx`：倾听时 rAF 每帧读 `micInputLevel()` 写入 `--level`；麦克风旁渲染 `data-testid="listening-wave"` 声波（含「正在听」文字，文字输入的倾听同样显示）；字幕区在 `phase === "thinking"` 时追加 `data-testid="thinking-dots"` 三点动画（字幕区内联 `<span>`，不改字幕区结构、不是聊天气泡）。
- `apps/client/src/live/live.css`：`.live-wave`（三根柱，高度随 `--level` 变化）与 `.live-thinking-dots`（1.2s 闪烁，三点错相 0.2s；`prefers-reduced-motion` 下退化为常亮）。
- `apps/client/src/live/uiText.ts`：加 `listening: "正在听"`。
- `apps/client/test/yunaParams.test.ts`：+229 行（明细见 §4）。
- `apps/client/test/controller.test.ts`：`fakeRecorder` 补 `level: () => 0`。

### 素材（未追踪新文件，源目录只读）

- `apps/client/public/models/yuna/expressions/`：`cry.exp3.json`（ParamCry）、`amazed.exp3.json`（ParamAmazed）、`pet.exp3.json`（ParamPet）、`shy.exp3.json`（ParamShy），复制自源目录对应中文名 exp3，文件名改英文。
- `apps/client/public/models/yuna/motions/`：`cry.motion3.json`（源 `motions/流泪.motion3.json`）。源模型目录即 `…-忧奈_processed.enc/` 根下只有 `motions/流泪.motion3.json` 一个 motion（REPORT §1.4），无需再按 `漠.vtube.json` 另找路径。
- 说明：exp3 / motion 的数值已按任务「exp3 开关值直接读进常量表、motion 曲线采样进纯函数」的方式落入 `yunaParams.ts`，运行时**不直接加载这些 JSON 文件**；文件按任务要求复制到 public 备查 / 备用。

## 2. 每个状态最终用的参数与数值

参数名全部以 `漠.cdi3.json` 为准（185 个参数）；视线 / 转头基线仍由 `params.ts` 的 `VIEW_BY_PHASE` + `clampView()` 给出（倾听 `eye 0,0 head 0,0,0`；思考 `eyeX -0.3` 等，沿用 S6a 设定）。

| 状态 | 参数（在基线上的增量） | 数值 |
|---|---|---|
| **待机 idle** | 呼吸 `ParamAngleY` / `ParamBodyAngleY` 正弦 | `sin(2π·tSec/3.2)`，幅度 1.2 / 0.8（既有） |
| | 眨眼 `ParamEyeLOpen/ROpen` | `blinkOpen × 1.3` 上限截断（既有） |
| | 视线漂移 | `VIEW_BY_PHASE.idle`（幅度小，既有） |
| | 小动作（`idleSinceSec > 8` 后按窗口轮换，kind 由 `seed` 决定：`floor(seed×3)`） | 窗口 = `(idleSince−8) % (6+4)`；`IDLE_ACTION_MIN_GAP_SEC=8`、`IDLE_ACTION_WINDOW_SEC=6`（即每 8–14s 一个） |
| | ├ seed∈[0,1/3) 抱熊 | `ParamPet=1`，持续 `IDLE_PET_SEC=4`s（3–5s 区间取 4） |
| | ├ seed∈[1/3,2/3) 瞟向一侧 | `ParamEyeBallX=0.3`、`ParamAngleX=−4`，持续 `IDLE_GLANCE_SEC=1.5`s |
| | └ seed∈[2/3,1] 耳朵轻动 | `ParamEarsLX1/RX1 = 0.4·sin(2π·tSec/0.8)`，持续 `IDLE_EAR_SEC=2`s |
| **倾听 listening** | 过渡权重 `w = min(1, phaseSinceSec / 0.3)`（300ms 内到位，`LISTEN_TRANSITION_SEC=0.3`） | |
| | 身体前倾 | `ParamBodyAngleY += 6·w`（`LISTEN_BODY_FORWARD=6`） |
| | 头微歪 | `ParamAngleZ += 6·w`（`LISTEN_HEAD_TILT_Z=6`，约 6°） |
| | 眼睛开到最大 | 不压 `EYE_OPEN_MAX` 之外的上限（情绪上限仍生效） |
| | 看镜头 | 视线基线 0,0（既有） |
| | 点头 | `ParamAngleY += listenNodOffset(phaseSinceSec)`：周期 `LISTEN_NOD_PERIOD_SEC=2.5`s（2–3s 区间），单峰宽 0.4s、峰值 `LISTEN_NOD_AMPLITUDE=3`°（ParamAngleY 小幅下上） |
| | UI | `listening-wave` 声波随 RMS 跳动 + 「正在听」 |
| **思考 thinking** | 过渡权重 `w = min(1, phaseSinceSec / 0.3)`（`THINK_TRANSITION_SEC=0.3`） | |
| | 头歪向另一侧 | `ParamAngleZ += −5·w`（`THINK_HEAD_TILT_Z=−5`，与倾听反向） |
| | 眨眼变慢 | `eyeOpen` 上限压到 `THINK_EYE_MAX=1.3` 之下（在既有 `applyEyeOpen` 情绪上限后再 `min`） |
| | 视线偏开 | `VIEW_BY_PHASE.thinking`（既有） |
| | UI | 字幕区 `thinking-dots`「……」三点动画 |
| **说话 speaking** | 口型 + 情绪 | 既有（`MOUTH_OPEN` / `EMOTION_PARAMS`） |
| | `sad` 叠加 | `ParamCry=1` + 流泪 6 参数（见下 `tearParams`） |
| | `warm` 叠加 | `ParamShy=1`（既有脸红，经 `EMOTION_PARAMS`） |
| | 首句回话惊讶 | `ParamAmazed=1` 当 `0 ≤ firstSpokeSinceSec < 1.2`（`SPEAK_AMAZED_SEC=1.2`）；调用方只在会话内第一次进入 speaking 时记录 `firstSpokeAt`，因此**只出现一次** |

**流泪 `tearParams(tSec)`**（`cry.motion3.json` 的 6 条曲线纯函数采样，周期 5.2s 循环，左右错开约 2.3s）：

| 参数 | 曲线 |
|---|---|
| `ParamTearLY` | t=0.58 起 0→1（t=2.17），2.44 过冲到 2，2.6 归零 |
| `ParamTearRY` | t=2.90 起同样波形，4.93 归零 |
| `ParamTearL` | 0→0.58 升到 1，保持到 2.6，之后 0 |
| `ParamTearR` | 2.3→2.9 升到 1，保持到 4.93，之后 0 |
| `ParamTearAppearL/R` | 对应 `*Y` 值 > 0.02 时为 1，否则 0 |

**`silentAction` 映射（`SILENT_ACTION_TABLE`）**：

| silentAction | 时长 | 参数 |
|---|---|---|
| `drink` | 1s | `ParamAngleY=8`（低头）、`ParamEyeLOpen=0`、`ParamEyeROpen=0`（闭眼） |
| `phone` | 2s | `ParamEyeBallY=−0.25`（视线向下） |
| `show_item` | 3s | `ParamPet=1`（抱熊） |
| `glance` | 1.5s | `ParamEyeBallX=0.3`、`ParamAngleX=−4`（看向一侧） |

**禁止参数（`FORBIDDEN_KEYS`，任何输入下恒为 0，属性测试兜底）**：`ParamFlyHead / ParamFlyHead2 / ParamFlyPet / ParamBlack / ParamDark / ParamAngry` + 水印授权文字 `Param1`–`Param10`。

## 3. cdi3 里找不到的参数

- `ParamTearAppearL` / `ParamTearAppearR`：出现在 `motions/流泪.motion3.json` 的曲线里（REPORT §1.4 也列出 6 条曲线含这两个），但 `漠.cdi3.json` 的 185 个参数表里没有这两项（只有 `ParamTearL / ParamTearLY / ParamTearR / ParamTearRY`）。`tearParams` 仍输出这两个键（值为 0/1），运行时若 moc3 里确无此参数会被 Live2D 忽略，无副作用。
- 倾听的「身体前倾」任务提示列举 `ParamBodyAngle*`/`ParamAngleY` 等，cdi3 实测存在 `ParamBodyAngleX/Y/Z`，选用 `ParamBodyAngleY`（前倾轴）。
- 耳朵参数 cdi3 实测为 `ParamEarsLX1/LX2/LY/LY2/RX1/RX2/RY1/RY2`，选用 `ParamEarsLX1/RX1` 做轻动。
- 其余用到的参数（`ParamAngleZ / ParamEyeBallX/Y / ParamCry / ParamAmazed / ParamPet / ParamShy / ParamEyeL/ROpen / ParamMouthOpenY / ParamMouthForm`）均在 cdi3 中存在。

## 4. 测试结果

- **单测**（`apps/client/test/yunaParams.test.ts`，新增 5 组 17 条）：
  - 倾听 ≠ 待机：`ParamBodyAngleY` 前倾与 `ParamAngleZ` 头歪同时不同；300ms 过渡（0 时无增量、半程介于 0 与目标之间）；点头周期落在 2–3s 且有峰值；倾听看镜头。
  - 思考：头歪与倾听反向（−5 vs +6）、`eyeOpen ≤ THINK_EYE_MAX`、保留视线偏开。
  - 待机小动作：`idleSinceSec ≤ 8` 无动作；seed=0.1/0.5/0.9 分别命中抱熊 / 瞟向一侧 / 耳朵。
  - 说话：`sad → ParamCry=1 + 泪参数键存在`；`warm → ParamShy=1`；`speakAmazed` 边界（undefined/0/1.19/1.2/5）。
  - `silentAction` 四条映射逐一断言参数与时长；`tearParams` 周期性与值域 [0,2]。
- **fast-check 属性测试**（`numRuns=1000`）：
  - 任意 `phase / emotion / tSec / silentAction / seed / look` → `FORBIDDEN_KEYS` 与 `Param1`–`Param10` 恒为 0；
  - 任意输入 → `|ParamEyeBallX| ≤ VIEW_LIMITS.gazeX`、`|ParamEyeBallY| ≤ VIEW_LIMITS.gazeY`、`|ParamAngleX/Y/Z| ≤ 30`（模型舒适区）。
- **e2e**（`e2e/s6f.spec.ts`，`E2E_SERVER_PORT=8988 E2E_CLIENT_PORT=5374`，见 §0 端口说明）：
  - 「频道栏只剩忧奈一个」：`live-name` = 忧奈；desktop 断言 `channel-yuna` 可见；两种布局都断言 `channel-rin` 计数为 0；
  - 「四态截图」：idle → PTT 按下进 listening → 发文字进 thinking → speaking，各截一张 `e2e/out/s6f-<phase>.png`，并用 `readPixels` 断言 Live2D 画布中心条带存在非透明像素（非空）。

## 5. smoke:real 结果

`PROVIDER_MODE=real`，缺省角色（yuna，隐藏角色 rin 的 `FISH_VOICE_ID` 未注入、启动不再报错）。两轮文字对话：

| 轮次 | LLM 首句 | TTS 首包 | 开始播放 | 无声降级 |
|---|---|---|---|---|
| 1 | **1086 ms** | 2198 ms | 2199 ms | false |
| 2 | **830 ms** | 2400 ms | 2401 ms | false |

调用次数：LLM 2（≤3）、TTS 5（≤8）。**`SMOKE:REAL OK`，成功，无降级。**

## 6. 和 S6c 可能冲突的文件清单

S6c worktree（`/Users/gjy/mira-wt-s6c`，分支 `s6c-scene`，弹幕换背景）当前改动与本批的交集：

| 文件 | S6f 改了什么 | 冲突评估 |
|---|---|---|
| `characters/rin/pack.json` | 只加一行 `"hidden": true` | S6c 也改了此文件（scene 相关）。单行新增，合并时应可自动或手工一行解决 |
| `apps/server/src/characters/pack.ts` | 加 `hidden` 字段、`defaultCharacterId()`、排序遍历 | S6c 也改了此文件。S6f 是新增段落，冲突面小 |
| `apps/server/src/index.ts` | 音色校验加 `if (pack.hidden) continue`（2 行） | S6c 也改了。仅 2 行 |
| `apps/server/src/session.ts` | 缺省角色 + 隐藏拒绝（约 6 行） | S6c 也改了。改动区域不同（S6f 在 hello 处理） |
| `apps/client/src/live/Live.tsx` | `VISIBLE_CHARACTERS` 三处替换 + 声波 / 思考点两个 JSX 片段 | S6c 也改了（弹幕背景）。区域不同，但同文件需留意 |
| `apps/client/src/live/live.css` | 文件末尾追加 `.live-wave` / `.live-thinking-dots` | S6c 也改了。追加式，冲突概率低 |
| `apps/client/src/live/uiText.ts` | 加一行 `listening` | S6c 也改了。一行 |
| `apps/client/src/core/controller.ts` | 加 `micInputLevel()`（5 行） | S6c 也改了 |
| `apps/server/test/pack.test.ts` | 断言对齐 | S6c 也改了 |
| `e2e/live.spec.ts` | 两个用例改写（不删测试） | S6c 也改了 |

S6f 独占、S6c 未碰：`yunaParams.ts`、`StageRenderer.tsx`、`recorder.ts`、`characters.ts`、`e2e/s6f.spec.ts`、`public/models/yuna/expressions|motions/`、各服务端测试 helper。合并建议：先合 S6c，再把 S6f 按上表逐文件三方合并（两边都是小范围新增，没有互相覆盖的意图）。
