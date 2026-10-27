# S6l-fix2 执行报告：Claude 独立审查发现的 9 个问题

> 执行者：Command Code（deepseek-v4-flash）。基线：合并 S6l-fix1 后的 main → 分支 `s6l-fix2`。
> 全部修复遵循「先写会失败的测试复现，再改代码让它通过」。**未 commit**。**按用户要求未运行 e2e**（冻结点统一跑）。
> 铁律遵守：Key 只从 `.env` 读取、未打印；未碰 `tools/live2d-pipeline/**`、`skills/**`；未用读文件工具打开任何图片；测试里未发真实网络请求；未改任何台词和样式。

## 结果

- `pnpm test`：90 个测试文件、**892 条测试全绿**（基线 883 条 → 新增 9 条）。
- `pnpm typecheck`：5 个 workspace 全部通过。
- `PROVIDER_MODE=mock pnpm smoke`：**SMOKE OK**（7 步全过，总耗时 3230ms）。
- e2e：按用户要求**未运行**。

## 各条修复与对应测试

### §1 手机端点任何东西都算「戳一下」（高）
- **纯函数**：`apps/client/src/live/interaction.ts` 新增 `isStageTapTarget(target)`（`closest` 命中 `button, a, input, textarea, select, [role=button], [data-no-stage-tap]` 即忽略）与组合函数 `resolveStageTap(phase, target, hitCharacter)`（交互元素内 / 未命中 / 相位不允许 → `null`）。
- **接线**：`Live.tsx` 手机 `onTouchEnd` 短按改走 `resolveStageTap`；桌面 `StageTapLayer` 加目标判定（防御）；`hitCharacterAt` 画布找不到时返回 `false`（不再当作命中）；引导弹幕、字幕区、顶栏、输入区容器加 `data-no-stage-tap`。
- **测试**：`apps/client/test/stageTap.test.ts`（9 条）——
  - `isStageTapTarget：交互元素内不算舞台点击（S6l-fix2 §1） > button / a / input / textarea / role=button 本身 → true`（及嵌套 / `data-no-stage-tap` / 普通元素 / null）；
  - `resolveStageTap：手机短按的完整判定（S6l-fix2 §1） > 点在输入框（即使坐标命中角色竖条）→ null，不发 poke`、`… > 点在舞台空白处且坐标命中角色 → poke`、`… > 说话时点空白处（未命中角色）→ interrupt` 等。

### §2 LLM 给了动作建议时 accent 被丢掉（高）
- **根因**：`director.ts` 调 `pickAccent` 时 `suggested: llmBeat.suggest === null ? llmBeat.accent : null`。
- **修法**：改为 `suggested: llmBeat.accent`。规则触发（熬夜 → dark）由 `pickAccent` 内部在 `suggested` 为空时判定，与 suggest 无关。
- **测试**：`apps/server/test/director.test.ts`——
  - `导演层：D47 语境表情 accent > S6l-fix2 §2：LLM 同时给了动作与 accent 时，accent 不被丢弃`（`{suggest:"glance",accent:"amazed"}` → action=glance、accent=amazed）；
  - `… > S6l-fix2 §2：给出动作但没给 accent、台词含熬夜 → 规则触发 dark`（`{suggest:"drink",accent:null}` → dark）。

### §3 表情在轮次结束 / 被打断后不清除（中）
- **修法**：`reducer.ts` 的 `toIdle()` 与 `beginTurn()` 把 `visual.accent` 置 `null`（渲染端按「结束」渐出 0.4s）。
- **测试**：`apps/client/test/reducer.test.ts`——
  - `beat 与视觉/字幕 > S6l-fix2 §3：带 accent 的 beat 播完 turn_end → idle 后 accent 为 null`；
  - `… > S6l-fix2 §3：带 accent 的 beat 中 PTT_DOWN / SUBMIT_TEXT 打断 → accent 清空`；
  - `… > S6l-fix2 §3：点击打断（listening）用 INPUT_CANCELLED 回 idle 时 accent 清空`。

### §4 点击打断后一直停在「倾听」（中）
- **修法**：`controller.ts` 新增常量 `TAP_LISTEN_GRACE_MS = 5000`；`tapInterrupt()` 打断后进入 listening，并在时间线排一条 `tap-listen-grace:<turnId>` 命令，5s 内没有新输入（文字 / 按住说话 / 引导点击都会递增 turnId，命令据此失效）就派发 `INPUT_CANCELLED` 回 idle。
- **测试**：`apps/client/test/controller.test.ts`——
  - `controller：点击打断后的倾听宽限（S6l-fix2 §4） > tapInterrupt → listening；推进 TAP_LISTEN_GRACE_MS 无新输入 → 回 idle`；
  - `… > 宽限内新输入（submitText）→ 正常新轮，到期不会被回退到 idle`。

### §5 「当前背景名」用一次就被清空（中）
- **修法**：`scene/job.ts` 把 `lastReadyLabel?` / `lastReadyUrls?` 拆成 `pendingReadyNote?`（一次性提示，用完清空）与 `currentBackground?: { label; urls }`（持久，换成功时覆盖）。`session.ts` 的 `scene_notes` 读 `pendingReadyNote`、参考图与扩写器 `currentScene`、`resumePayload` 的背景都读 `currentBackground`。
- **测试**：`apps/server/test/sceneBackgroundLabel.test.ts`（3 条）——
  - `当前背景名持久化（S6l-fix2 §5） > 换背景成功 → 下一轮含「背景已经换成 X」，再下一轮不含`；
  - `… > 第二次换背景时扩写器收到的 currentScene 仍是上一次换成的背景名`；
  - `… > 刷新恢复的 background.label 仍是当前背景名（提示已用掉后）`。

### §6 戳一下 / 送礼物只有客户端冷却（低）
- **修法**：新增协议模块 `packages/protocol/src/throttle.ts`（`POKE_COOLDOWN_MS=3000`、`GIFT_COOLDOWN_MS=10000`、纯函数 `throttleEvent(lastAt, now, kind)`）；客户端 `interactionHooks.ts` 改用共享常量。服务端 `session.ts` 对 `text_input` 的 poke / gift 按会话限流：冷却内重复请求直接忽略（不起新轮、不扣轮数、记 `input_throttled` 日志）。
- **测试**：
  - `packages/protocol/test/throttle.test.ts`（首次放行 / 冷却内忽略 / 冷却到点放行 / 时钟回退忽略）；
  - `apps/server/test/pokeGift.integration.test.ts > S6l-fix2 §6：服务端 poke / gift 限流`（3s 内第二次 poke 无 beat；超过 3s 正常；gift 5s 内忽略、10s 后正常）。既有「第二次 poke = angry」用例已改为先推进 3s 时钟（`setup()` 现在用可注入时钟）。

### §7 钩子轮 / poke / gift 被算作「用户说过话」（低）
- **修法**：`ports.ts` 的 `LLMHistoryEntry` 加 `source?: "user" | "nudge" | "poke" | "gift"`（缺省 user 兼容旧数据）；`session.ts` 落历史时按 `inputKind` / nudge 记录来源；`renderPrompt.ts` 的 `userTurns` 只数 `source === "user"`；`resumePayload` 的 transcript 只保留 `source === "user"` 的用户条目（assistant 照旧）。
- **测试**：
  - `apps/server/test/prompts.test.ts > renderPrompt > S6l-fix2 §7：历史里只有 nudge / poke / gift 占位时，arrive 不推进` 与 `… > S6l-fix2 §7：有一句真实用户输入后按原规则推进（arrive → 允许进入 probe）`；
  - `apps/server/test/sessionResume.test.ts > S6l-fix2 §7：transcript 不含 nudge / poke / gift 占位（assistant 照旧）`。

### §8 accent A 直接切到 B 时 A 瞬间消失（低）
- **修法**：`accentParams.ts` 新增纯函数 `accentBlend(prev, current)`（逐键取最大值）；`StageRenderer.tsx` 的 accentRef 保留「正在渐出的上一个 accent」（`prev + endedAtMs`），每帧把 prev 与 current 经 `accentBlend` 合成后交给 `yunaParams`（新增 `accentBlended` 入参，传入时优先使用）；prev 渐出完成后丢弃。
- **测试**：`apps/client/test/accentParams.test.ts > accentBlend：A 切到 B 时 A 渐出、B 渐入（S6l-fix2 §8）`——切换瞬间 A 权重 1 / B 权重 0；半程各 ≈0.5；A 渐出完成后仅剩 B；prev=null 等价单一 accent；同参数取最大值。

### §9 兜底语音在两句台词之间插播又被掐断（低）
- **修法**：`localAudio.ts` 新增 `turnActive` 状态与 `turnEnded()` 方法：`beatEnded()` 只标记不再播放排队语音；排队语音只在 `turnEnded()`（回到 idle / listening）时播放。`play` 句柄支持「播完回调」，播完把 `active` 置 null（修 `isPlaying()` 一直为 true）。`audio.ts` 的 `playLocalVoiceAudio` 接 `onEnded`；store 订阅在相位变为 idle / listening 时调用 `localAudio.turnEnded()`。
- **测试**：`apps/client/test/localAudio.test.ts`——
  - `本地音频仲裁（S6l-fix1 §6） > beat 播放期间 request → 排队，本轮结束后才播（S6l-fix2 §9）`；
  - `… > S6l-fix2 §9：两个 beat 之间有排队语音 → beat 之间不播放`；
  - `… > S6l-fix2 §9：本地语音自然播完后 isPlaying() 为 false（active 清空）`（属性测试同步加入 `turnEnded` 操作）。

## 关卡 1–5 落实（Claude 决定）

1. **YAGNI**：只修这 9 条，未加功能。
2. **端口/适配器**：未碰外部服务；限流常量放协议层（客户端 / 服务端共享一份）。
3. **函数式核心**：`isStageTapTarget` / `resolveStageTap` / `throttleEvent` / `accentBlend` 均为纯函数；状态清理在 reducer（`toIdle` / `beginTurn`）与 `localAudio` 的 `turnActive` 状态机内。
4. **契约式设计**：舞台点击只认空白处；accent 只在其 beat 内生效、任何轮次切换都清除；点击打断后的倾听最长 5s；当前背景是持久状态、一次性提示另存。
5. **测试奖杯**：每条一个先失败的回归测试（单测或集成），未跑 e2e。

## 变更清单

- 新增：`packages/protocol/src/throttle.ts`、`apps/server/test/sceneBackgroundLabel.test.ts`、`apps/client/test/stageTap.test.ts`、`packages/protocol/test/throttle.test.ts`。
- 修改：
  - 客户端：`live/interaction.ts`、`live/Live.tsx`、`live/StageRenderer.tsx`、`live/interactionHooks.ts`、`state/reducer.ts`、`core/controller.ts`、`core/localAudio.ts`、`core/audio.ts`、`render/live2d/accentParams.ts`、`render/live2d/yunaParams.ts`。
  - 服务端：`director/director.ts`、`scene/job.ts`、`session.ts`、`ports.ts`、`prompts/renderPrompt.ts`。
  - 协议：`index.ts`。
  - 测试：`director.test.ts`、`prompts.test.ts`、`sessionResume.test.ts`、`pokeGift.integration.test.ts`、`accentParams.test.ts`、`localAudio.test.ts`、`reducer.test.ts`、`controller.test.ts`。

## 未决 / 备注

- **§5 字段迁移**：把 `SceneJobState.lastReadyLabel / lastReadyUrls` 直接替换为 `pendingReadyNote / currentBackground`（无历史数据需要兼容——会话在内存中，进程重启即丢）。`packages/protocol/src/messages.ts` 里一句引用旧字段名的注释未改（纯注释，无行为影响）。
- **§6 限流语义**：服务端在 `handleMessage` 里对 poke / gift 限流，**只对穿过限流的请求调用 `handleTurnInput`**；被限流的请求不产生 `turn_end` / `error` 下行，客户端由本地冷却兜底（客户端已先于服务端过滤）。
- **§4 宽限**：命令带 `turnId = 新 listening 轮`；`performInterrupt` 的 `cancelTurn` 只清旧轮命令，宽限命令在其之后排入，不被旧轮取消；新输入递增 turnId 后该命令自动失效。
- e2e 按要求**未运行**。
