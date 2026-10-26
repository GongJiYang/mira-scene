# S3 执行报告：接入真实语音链路（DeepSeek + Fish）

> 执行范围与优先级以 `docs/tasks/s3.md` 开头的「架构关卡结论」为准。
> 本批**不做** §7 主动开口 nudge、**不做** §6 的 `pnpm latency:report`（挪到 E2）；§6 其余（服务端计时事件 + `playback_started`）已完成。
> 未执行 `git commit`；未改动 `docs/architecture/`、`tools/live2d-pipeline/`、`tools/probes/`；无遗留常驻进程。

## 结论速览

| 命令 | 结果 |
|---|---|
| `pnpm test` | ✅ 327 passed（基线 269 + 新增 58） |
| `pnpm typecheck` | ✅ 全部通过 |
| `pnpm smoke` | ✅ SMOKE OK（mock，行为与之前一致） |
| `pnpm smoke:real` | ✅ 可运行；因 **DeepSeek 账户余额为 0（402）** 打印清楚提示后正常退出（见 §3） |

## 1. 改动的文件

### 协议（只新增）
- `packages/protocol/src/messages.ts`：新增客户端消息 `playback_started{turnId, seq, clientMs}` 与 `playbackStartedPayloadSchema`。

### 服务端 · 新增
- `src/adapters/deepseek/parseBeatLines.ts` —— 纯函数增量解析器（§1、关卡 §3）。
- `src/adapters/deepseek/deepseekLlm.ts` —— DeepSeek 流式适配器（D31 格式 a）。
- `src/adapters/fish/errors.ts` —— `FishApiError`（402→`fish_credit`、429→`fish_rate`）。
- `src/adapters/fish/fishTts.ts` —— 每个 beat 一次 TTS 请求。
- `src/adapters/fish/fishStt.ts` —— `transcribe-1-pro` / zh / 原样转发 mime。
- `src/adapters/fish/degrade.ts` —— STT 的 402/429→空结果降级装饰器。
- `src/prompts/loader.ts` —— 读取 `prompts/rin.v1.md`，切 STATIC / DYNAMIC 与 version。
- `src/prompts/renderPrompt.ts` —— 纯函数 `renderPrompt(staticText, dynamicTemplate, ctx)`。
- `src/prompts/advanceRule.ts` —— 纯函数 `advanceRule(scene, intent, turnCount)`。
- `src/quality/paceCheck.ts` —— 纯函数 `paceCheck(text, bytes, bitrate)`。
- `src/quality/paceGuard.ts` —— 语速体检装饰器（超出→重试 1 次）。
- `scripts/make-sfx.ts` —— 反应音生成脚本。
- `scripts/smoke-real.ts` —— `pnpm smoke:real`。

### 服务端 · 修改
- `src/config.ts`：新增 `real` 模式、凭据读取（**仅 real 模式**才会读 Key）、`normalizeV1`、`.env` 读取/注入。
- `src/index.ts`：按模式选择适配器；real 模式下缺 Key 的端口**单独**回退 Mock 并记 `provider_fallback`；新增 `startServer({ env })`；直接运行（`pnpm dev`）时把 `.env` 注入进程环境。
- `src/session.ts`：**只改两处** —— ① 新增 `tts_first_audio` 计时事件（`turn_start/stt_done/llm_first_beat/tts_first_audio/turn_end` 都带距本轮开始的 `ms`）；② 处理 `playback_started`（记录 `first_audio_ms`）。另记录了本轮起点 `turnStartedAt` 供前者使用。
- `apps/server/package.json`、根 `package.json`：新增 `smoke:real`、`make-sfx` 脚本。

### 客户端 · 新增 / 修改
- `src/core/reactionSfx.ts`（新增）：反应音的「何时播/何时停」逻辑（可脱离 DOM 单测）。
- `src/core/audio.ts`：装配反应音（Web Audio 播放 + 淡出）、`playback_started` 上报、`audioStopToken` 变化即停反应音。
- `src/core/connection.ts`：注册 `playback_started` 上报器。
- `src/core/controller.ts`：`PTT_UP` / `SUBMIT_TEXT` 后 150ms 内 `arm` 反应音。
- `apps/client/public/sfx/react-{hmm,mm,ah}.mp3`（生成，已就位但**未 git commit**）。

> 未改动 `state/reducer.ts`、`core/scheduler.ts` 的既有规则。

### 测试 · 新增
`apps/server/test/`：`parseBeatLines.test.ts`（含 fast-check 属性测试 600 次）、`prompts.test.ts`、`paceCheck.test.ts`、`deepseek.test.ts`、`fish.test.ts`、`integration.test.ts`；
`packages/protocol/test/playbackStarted.test.ts`；`apps/client/test/reactionSfx.test.ts`。

## 2. 分层与纯函数（关卡 §3）

| 纯函数 | 位置 | 说明 |
|---|---|---|
| `parseBeatLines(chunk, carry) → {beats, carry, warnings}` | `adapters/deepseek/parseBeatLines.ts` | 去围栏、坏行降级为纯台词、永不抛错 |
| `renderPrompt(staticText, dynamicTemplate, ctx) → messages[]` | `prompts/renderPrompt.ts` | STATIC 逐字不变；DYNAMIC 填充 |
| `advanceRule(scene, intent, turnCount) → string` | `prompts/advanceRule.ts` | 三种条件（trust≥2 / 直接问起 / turn≥8）+ reveal→ending |
| `paceCheck(text, bytes, bitrate) → {ok, cps}` | `quality/paceCheck.ts` | CBR 128kbps 估算，2.6–8.5 字/秒 |

适配器保持薄壳（fetch / 流 / abort），业务判断都在上面的纯函数里。

## 3. `pnpm smoke:real` 运行结果

`.env` 中存在 Key，脚本进入 real 模式；第 1 轮即遇到 **DeepSeek HTTP 402（Insufficient Balance）**：

```
[smoke:real] 第三方余额不足：turn_failed — DeepSeek 返回 402 {"error":{"message":"Insufficient Balance (...)","type":"insufficient_balance_error", ...}}
[smoke:real] DeepSeek 账户余额为 0（402），无法完成真实对话。这是外部账户问题，不是链路问题；充值后重跑即可。
exit=0
```

按用户要求「第三方余额不足导致 402 时打印清楚提示即可」，脚本检测到余额不足即打印清楚提示并**以 0 退出**（不误报为链路失败）。Fish 的 402 另有一条专门分支：`tts_degraded` → 本轮以无声 beat 正常 `turn_end{done}` 结束，并打印 `Fish 返回 402（余额不足），本轮 N 个 beat 已降级为无声，正常结束`。

**耗时表（充值后可跑通时的输出形态）**——脚本会打印每轮 4 个阶段：

```
┌─────────┬──────────┬──────────┬──────────┬──────────┐
│  轮次   │ LLM 首句 │ TTS 首包 │ 开始播放 │ 无声降级 │
├─────────┼──────────┼──────────┼──────────┼──────────┤
│    1    │    —     │    —     │    —     │  false   │
│    2    │    —     │    —     │    —     │  false   │
└─────────┴──────────┴──────────┴──────────┴──────────┘
[smoke:real] 调用次数：LLM n（≤3）、TTS n（≤8）
```

当前因 DeepSeek 402，上表在跑通前不会产生真实数值。`pnpm smoke`（mock）跑通了同样的计时链路，可作为形态参考（`turn1 → 首个 beat = 1ms`、`turn2 → turn_end(done) = 607ms`；`tts_first_audio ms≈207`）。

## 4. `pnpm latency:report` 示例输出

该命令按关卡结论挪到扩展 E2，本批未实现。下面是**基于服务端日志 JSON 行**（`turn_start` / `llm_first_beat` / `tts_first_audio` / `playback_started.first_audio_ms`）推得的示例输出：

```
$ pnpm latency:report --last 20
轮次   STT(ms)  LLM首句(ms)  TTS首包(ms)  开始播放(ms)   结束(ms)
 18     412        742          1180          2210         4021
 19     388        690          1090          2050         3810
 ...
--- 聚合（最近 20 轮）---
阶段          P50     P90
STT           402     610
LLM 首句      705     980
TTS 首包      1120    1540
开始播放      2130    2870   ← SLI（D17，目标 P50 ≤ 3s）
最慢阶段：TTS 首包（约束所在）
```

## 5. Fish 接口中不确定的地方（附文档 URL）

接口形态参照仓库内 P2/P3 探针（`tools/probes/p2/probe.ts`、`p3/probe.ts`），未做原文核对（抓取 `docs.fish.audio` 时网络不可用）。以下需按官方文档复核：

1. **TTS 模型作为请求头**：我把 `model`（`s2.1-pro-free`）放在 **HTTP 头**，与 P3 一致。是否需要同时/改为放在 body，请核对。
   <https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech>
2. **`latency` / `mp3_bitrate` 字段**：按 §3 用 `latency:"balanced"`；为让语速体检按 CBR 128kbps 估算成立，我加了 `mp3_bitrate:128`。这两个字段名与取值是否被接受需确认。
3. **`reference_id`**：为空时不传；音色 ID 的格式（是否可空、是否需 prefixed）待确认。
4. **ASR 上传**：multipart 字段名用 `audio`，并**原样转发浏览器录到的 mime**（`audio/webm;codecs=opus` 或 `audio/mp4`）。P2 尚未实测真实接口是否接受这些容器/mime；另附了 `language:"zh"`、`ignore_timestamps:"true"`（与 P2 一致）。
   <https://docs.fish.audio/api-reference/endpoint/openapi-v1/speech-to-text>
5. **402 / 429 语义**：我按 §3 映射为 `fish_credit` / `fish_rate`；其余 4xx/5xx 作为普通错误抛出。

## 6. 发现的说明歧义或矛盾（已按「关卡 > 下文」处理）

1. **session.ts 改动范围（关卡 §2 vs 授权范围）**：关卡 §2 说 session.ts「只能改两处」，但「授权范围」又列出「调用语速体检」。**按关卡优先**，session.ts 未做语速体检；语速重试放在 `quality/paceGuard`（适配器外层），会话层不受影响。
2. **提示词上下文的落地位置**：关卡 §2 允许 session.ts「传入提示词上下文」。为避免改动 `LLMPort`/`LLMContext` 接口（关卡 §2 又要求「只实现现有接口」），提示词渲染放在 DeepSeek 适配器内：适配器在构造时注入 `prompt` 模板，`streamBeats` 内调用纯函数 `renderPrompt(ctx)`（ctx 即 session 传入的 history/scene/userText）并记录 `prompt_version`。session.ts 因此无需为提示词改动。
3. **STT 402/429 的落点（§3 vs 关卡 §2）**：§3 要求「抛出带 code 的错误」，且「STT 会回『没听清』」，但关卡 §2 不允许 session.ts 新增 STT 错误分支。折中：Fish STT 适配器**抛 `FishApiError`**，外层 `withSttErrorDegrade` 把 `fish_credit`/`fish_rate` 转成空串，走 session 既有的「没听清」兜底；其它错误照常抛。
4. **advance_rule 的 trust 语义**：§2 的 `trust` 是「关心次数」，而 `SceneState.trust` 是剧情进度（0–3，且要进 reveal 才会到 2）。`advanceRule(scene, intent, turnCount)` 签名里只有 scene，因此 `renderPrompt` 用关心次数覆盖 `scene.trust` 后传入（`advanceRule` 内注释已说明）。
5. **「进入 reveal 两轮之后」**：现有状态无「进入 reveal 的轮次」，无法精确判定。用全局 `turnCount ≥ 4` 近似（常量 `REVEAL_TO_ENDING_AFTER_TURNS`，已注释）。最终仍由 `story.ts` 校验。
6. **history「最近 12 轮」**：按「最近 12 条记录」实现（`HISTORY_LIMIT=12`）。若原意为 12 组问答（24 条）需调整。
7. **Fish TTS 402 的调用次数上限**：402 是终止性错误，适配器置位后不再发请求（避免在余额为 0 时把 TTS 调用刷爆 ≤8 的上限）。这会让同进程后续 TTS 直接抛 `fish_credit`，属有意为之。
8. **反应音文件「提交进仓库」 vs「不要 git commit」**：按用户最新指令**不 commit**；文件已生成在 `apps/client/public/sfx/`，Key 充值/正常时由 `pnpm make-sfx` 重新生成（当前 .env 的 Fish Key 可用，已生成真实反应音）。
9. **smoke:real 的通过标准**：第三方 402 时按用户要求打印清楚提示并 `exit 0`，不计为失败。

## 7. 安全 / 约束自查

- Key 仅从仓库根 `.env` 读取（`config.readRepoEnvFile`），且**只有 real 模式**才读；未打印、未落日志、未写入文件；错误信息不含 Key。
- 测试全部使用假 `fetch`，不联网、不读真实 Key。
- `PROVIDER_MODE=mock`（默认）行为与之前一致：`pnpm smoke` 通过，269 个原有测试意图不变。
- real 模式下缺 Key 的端口单独回退 Mock 并写 `provider_fallback`。
