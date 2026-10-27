# S6l-fix2 任务说明：Claude 独立审查发现的 9 个问题

> 来源：Claude 对 S6c-fix1 / S6k / S6l 核心与易错部分的独立审查（2026-10-28，用户要求），以下问题均已对照代码核实。执行者：Command Code（deepseek-v4-flash）。在合并了 S6l-fix1 的 main 上做。

## 铁律
冲突停下写进报告；Key 规则见 CLAUDE.md（D49）；不准 commit；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片；长命令显式传大 timeout，同一命令超时两次就停下写进报告；测试里不发真实网络请求；**不要运行 e2e**（冻结点统一跑）。每一条先写会失败的测试复现，再改代码；报告列出测试名。不改台词和样式。

## §1 手机端点任何东西都算「戳一下」（高）
- 现状：`apps/client/src/live/Live.tsx` 手机根容器 `live-mobile` 的 `onTouchEnd` 把所有短按都交给 `onStageTap(hitCharacterAt(...))`，没有排除交互元素；`hitCharacterAt` 只看坐标（画布中间 60% 竖条）。点输入框、引导弹幕、字幕、菜单、截图卡片关闭钮时，只要在中间竖条且忧奈没在说话，就会发出 poke 一轮。画布找不到时还直接返回 `true`。
- 修法：短按只有落在**舞台空白处**才当点击——事件目标（`event.target`）在 `button, a, input, textarea, [role=button], [data-no-stage-tap]` 内（`closest`）时一律忽略；引导弹幕、字幕区、顶栏、输入区容器加 `data-no-stage-tap`。画布找不到时返回 `false`。桌面 `StageTapLayer` 同样加这条目标判定（防御）。
- 测试：纯函数 `isStageTapTarget(el)` 单测；组件/集成测试：手机布局下在输入框位置短按 → 不调用 poke；在舞台空白处短按 → 调用。

## §2 LLM 给了动作建议时 accent 被丢掉（高）
- 现状：`apps/server/src/director/director.ts` 调 `pickAccent` 时 `suggested: llmBeat.suggest === null ? llmBeat.accent : null`——只要 LLM 同时给了动作（suggest），accent 就被丢弃。提示词示例本身就是 `suggest` + `accent` 同时出现。
- 修法：`suggested: llmBeat.accent`。「熬夜类台词 → dark」的规则触发条件是「LLM 没给 accent」（S6k 报告歧义 #1 的裁定），与 suggest 无关。
- 测试：director 层测试——`{suggest:"glance", accent:"amazed"}` → 第一个 beat 的 accent 为 amazed；`{suggest:"drink", accent:null, say 含「熬夜」}` → dark。

## §3 表情在轮次结束 / 被打断后不清除（中）
- 现状：`apps/client/src/state/reducer.ts` 只在新 beat 开始时更新 `visual.accent`；`toIdle()`、`beginTurn()` 都不清它。最后一句带 accent、或在带 accent 的 beat 中打断时，表情一直挂到下一句（如飞头、脸黑在待机时一直在）。
- 修法：`toIdle()` 与 `beginTurn()` 把 `visual.accent` 置 null（渲染端按「结束」渐出 0.4s，`StageRenderer` 的 accentRef 已支持 incoming=null → 记 endedAt）。
- 测试：reducer 单测——带 accent 的 beat 播完 turn_end → idle 后 accent 为 null；带 accent 的 beat 中 PTT_DOWN / SUBMIT_TEXT / 点击打断 → accent 为 null。

## §4 点击打断后一直停在「倾听」（中）
- 现状：`controller.tapInterrupt()` 走 `performInterrupt("tap")`，`clearState` 派发 `PTT_DOWN` → phase `listening`，但没有录音、也没有任何退出路径；状态牌一直「在听你说」，引导弹幕 / 沉默钩子（只在 idle 触发）全部失效。
- 修法：点击打断后进入 listening，**5 秒内没有新输入（文字、按住说话、引导点击）就派发 `INPUT_CANCELLED` 回到 idle**；有新输入则正常开始新一轮。计时挂到现有 timeline（可按轮取消），常量 `TAP_LISTEN_GRACE_MS = 5000`。
- 测试：单测——tapInterrupt 后推进 5s → idle；5s 内 submitText → 正常新轮且不会被回退到 idle。

## §5 「当前背景名」用一次就被清空（中）
- 现状：`apps/server/src/session.ts` 把 `sceneJob.lastReadyLabel` 同时当作「下一轮提示一次『背景已经换成 X』」和「当前背景描述」（扩写器 `currentScene`、刷新恢复的背景 label）。下一轮用完提示后执行 `lastReadyLabel = undefined`，当前背景名随之丢失。
- 修法：拆成两个字段——`pendingReadyNote?: string`（一次性提示，用完清空）与 `currentBackground?: { label; urls }`（持久，换成功时覆盖）。`currentScene`、参考图（S6l-fix1 §0）、刷新恢复（S6l-fix1 §1）都读 `currentBackground`。若 S6l-fix1 已引入等价字段，复用它，不要再造一份。
- 测试：集成——换背景成功 → 下一轮 scene_notes 含「背景已经换成 X」→ 再下一轮不含；但第二次换背景时扩写器收到的 `currentScene` 仍是 X；刷新恢复的 background.label 仍是 X。

## §6 戳一下 / 送礼物只有客户端冷却（低）
- 修法：服务端按会话限流——poke 3 秒、gift 10 秒内重复的请求直接忽略（不起新轮、不扣轮数、记 `input_throttled` 日志），常量与客户端一致并放在 protocol 共享。纯函数 `throttleEvent(lastAt, now, kind)` 单测。

## §7 钩子轮 / poke / gift 被算作「用户说过话」（低）
- 现状：`apps/server/src/prompts/renderPrompt.ts` 的 `userTurns = history.filter(role === "user").length`，主动开口轮的占位、poke/gift 的占位都算进去，用户一句没说也可能从 arrive 推进。
- 修法：history 条目记录来源（`source: "user" | "nudge" | "poke" | "gift"`，缺省 user 兼容旧数据），`userTurns` 只数 `source === "user"`。
- **同源问题（S6l-fix1 合并后发现）**：刷新恢复的 `transcript`（`session.ts` 的 `resumePayload`）把主动开口占位「（客人安静地坐着，没有说话）」和 poke/gift 占位「（观众做出了一个动作，没有说话）」当作用户消息发回，客户端 `live/sessionRestore.ts` 会把它们显示成「你」发的弹幕。修法：transcript 只包含 `source === "user"` 的用户条目（assistant 条目照旧）。
- 测试：只有 nudge / poke / gift 时 arrive 不推进；有一句真实用户输入后按原规则推进；resumePayload 的 transcript 不含 nudge / poke / gift 占位。

## §8 accent A 直接切到 B 时 A 瞬间消失（低）
- 现状：`apps/client/src/live/StageRenderer.tsx` 的 accentRef 只记一个 accent，切换时直接覆盖。
- 修法：保留「正在渐出的上一个 accent」（prev + 其 endedAt），渲染时两者都经 `accentParams` 取最大值；prev 渐出完成后丢弃。纯函数单测：切换瞬间 A 的权重从 1 线性降到 0（0.4s），B 从 0 升到 1。

## §9 兜底语音在两句台词之间插播又被掐断（低）
- 现状：S6l-fix1 的 `apps/client/src/core/localAudio.ts` 在每个 beat 的 `beatEnded()` 就播放排队的本地语音；一轮里两句之间的空档会开始播，下一句 `beatStarted()` 立刻把它停掉，听起来是一个被截断的短音。另外 `active` 在本地语音自然播完后不会清空（`isPlaying()` 一直为 true，`audio_overlap` 会误报）。
- 修法：排队的本地语音只在**本轮结束、回到 idle**（或 listening）时播放，不在 beat 之间播；`play` 返回的句柄支持「播完回调」，播完把 `active` 置 null。
- 测试：两个 beat 之间有排队语音 → beat 之间不播放，turn 结束后才播；本地语音播完后 `isPlaying()` 为 false。

## §10 验收
`pnpm test`、`pnpm typecheck` 全绿；`PROVIDER_MODE=mock pnpm smoke` 通过。报告 `docs/tasks/s6l-fix2-report.md`：每条修复 → 测试名、未决歧义。

## 关卡 1–5 结论（Claude 决定，均为正确性修复）
1. **YAGNI**：只修这 9 条，不加功能。
2. **端口/适配器**：不碰外部服务。
3. **函数式核心**：`isStageTapTarget`、`throttleEvent`、accent 渐变合成为纯函数；reducer 负责状态清理。
4. **契约式设计**：舞台点击只认空白处；accent 只在其 beat 内生效、任何轮次切换都清除；点击打断后的倾听最长 5s；当前背景是持久状态、一次性提示另存。
5. **测试奖杯**：每条一个先失败的回归测试（单测或集成），不跑 e2e。
