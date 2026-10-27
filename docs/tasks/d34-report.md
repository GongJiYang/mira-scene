# D34 报告：可打断的多模态演出时间线

基线：`139eca5`（`docs: D34 decision and task spec`）。未 commit。未改 `docs/architecture/`。未碰 `tools/`（`tools/live2d-pipeline/*` 是用户原有改动，保持原样）。全程未打印、未写入任何 Key；测试与 e2e 均不发真实网络请求（e2e 强制 `PROVIDER_MODE=mock`）。结束后未留常驻进程（5273 / 8887 已释放，`lsof` 复核为空）。

## 0. 验收结果

| 命令 | 结果 |
|---|---|
| `pnpm test` | ✅ 44 个文件 / **432 tests passed**（基线 392，新增 40） |
| `pnpm typecheck` | ✅ 4 个 workspace 全部 Done |
| `pnpm smoke` | ✅ `SMOKE OK`（3228ms） |
| `pnpm e2e` | ✅ **6 passed / 4 skipped**（连跑 2 次稳定；新增 Q1 用例见 §4） |

新增/改写的测试（40 条）：`mouth.test.ts` 13、`timeline.test.ts` 10、`interrupt.test.ts` 9、`interruptMatrix.property.test.ts` 8（含属性测试 1，`numRuns=1000`）；改写 `performance.test.ts` 2 条（见 §2）。

## 1. 改动的文件

### 新增（授权范围内）
- `apps/client/src/state/mouth.ts`：纯函数 `levelToMouth(rms, prev, dtMs)`、`mouthFor(phase, audioPlaying, shape)`、`fallbackMouth(elapsed)` + 阈值配置 `MOUTH_LEVEL_CONFIG`。
- `apps/client/src/core/timeline.ts`：纯数据结构 `timelineAdd / timelineCancelTurn / timelineDue / timelineNextAt / timelineCountForTurn / timelineStoryCount` + 命令式外壳 `createTimeline`（**单个**定时器）+ debug 环形缓冲区（`pushTimelineLog / timelineLog`，容量 200）。
- `apps/client/src/core/interrupt.ts`：纯函数 `interruptPlan(state)`、`interruptViolations(snapshot)` + 外壳 `createInterruptExecutor(deps)`。
- `apps/client/src/core/audioLevel.ts`：端口 `AudioLevelSource`、纯函数 `rmsFromTimeDomain(samples)`、生产适配器 `createAnalyserLevelSource(context)`。

### 修改（授权范围内）
- `apps/client/src/core/audio.ts`：接线 `source → analyser → destination`（`fftSize=512`）；rAF 每帧读时域数据算 RMS → `levelToMouth` → dispatch B 的 `MOUTH`；无声 beat 的 1200ms、反应音淡出拆除、反应音 arm 计时全部迁到 `timeline`；导出 `stopPlaybackNow / forceMouthClosed / isAudioPlaying / isReactionActive` 供打断执行器使用；store 订阅保留为**幂等**兜底。拿不到 `AnalyserNode` 时退回「120ms small/open 交替」并写日志。
- `apps/client/src/core/controller.ts`：`pttDown / submitText` 在 `phase !== idle` 时调用有序执行器 `performInterrupt`（`PTT_DOWN`→reason `ptt`，`SUBMIT_TEXT`→reason `text`）；执行器 deps 里的每步打点写 `performance.mark`，每步写 debug 环形缓冲区 `{t, step, turnId}`，执行完校验后置条件（违反则 `console.error` + 写日志）。
- `apps/client/src/core/reactionSfx.ts`：`ReactionDeps.setTimer` 增加 `turnId` 形参，使反应音计时可挂到 `timeline` 并按轮取消（既有测试无需改动）。
- `apps/client/src/state/performance.ts`（**唯一授权的 B 规则修改**）：删除 `MOUTH_TICK` 的计时器轮换（`MOUTH_CYCLE`），改为 `MOUTH` 动作经 `mouthFor` 推导口型。其余规则（眨眼、手势、待机、nudge）未动。
- `apps/client/src/core/performanceClock.ts`：外壳节拍从 `setInterval` 改为 `timeline` 驱动的**单个**定时器；nudge 计时改为进入 idle 时向 `timeline` 注册、离开时取消。纯 `createPerformanceClock` 与其导出（含 `mouthDelayMs`）**未改**，其测试全部保持原样。
- `apps/client/package.json` + `pnpm-lock.yaml`：新增 devDependency `fast-check@^4.10.2`（客户端属性测试用）。
- `e2e/stage.spec.ts`：新增 §4 的 Q1 用例（用例 5）。

### 渲染层「读取口型的地方」
`apps/client/src/stage/layers.ts` 与 `view/Stage.tsx` 只读取 `performance.mouth`（形状），本就不接触 Web Audio —— **无需改动**即满足「渲染层只读取口型形状」的端口约束。（授权允许改，但实际未改，如实在此说明。）

## 2. 改写的 B 测试（逐条：改前 → 改后）

授权：「原来测试「口型按计时器轮换」的用例，允许改写成「speaking 时口型跟随音量；音频停止的那一帧变为 closed」」。改写两条：

1. `apps/client/test/performance.test.ts`
   - 改前：`it("嘴在 closed / small / open 之间循环", …)` —— 连续 `MOUTH_TICK` 断言 `small → open → closed`。
   - 改后：`it("speaking 时口型跟随音量；音频停止的那一帧变为 closed", …)` —— `MOUTH{shape:"open",audioPlaying:true}` → `open`；`MOUTH{shape:"small",audioPlaying:true}` → `small`；`MOUTH{shape:"open",audioPlaying:false}` → `closed`（音频停止那一帧回到 closed）。

2. `apps/client/test/performance.test.ts`
   - 改前：`it("非 speaking 时口型 tick 被忽略", …)` —— 用 `MOUTH_TICK` 断言 idle 不变。
   - 改后：`it("非 speaking 时口型一律 closed（忽略传入的音量形状）", …)` —— 用 `MOUTH{shape:"open",audioPlaying:true}` 断言 idle 下仍返回同一引用（`mouthFor` 把非 speaking 一律压成 closed）。

除以上两条外，现有 392 条测试意图零改动。

## 3. 属性测试（§4 主力）

- 文件：`apps/client/test/interruptMatrix.property.test.ts`。
- 模拟客户端核心 = 真实 `reducer`（A）+ `performanceReducer`（B）+ `storyMediaReducer`（C）+ 真实 `createTimeline` + 假音频（可控「解码完成 / 开始播放 / 播放结束」）+ 假音量源。
- 生成器：固定进入 speaking 的前缀 `[submit, beat0, tts0, decode0]` + 随机交错事件（`submit / pttUp / nudge / beat0 / beat1 / mediaBeat / turnEnd / tts0 / decode0 / tts1 / decode1 / playEnd / mediaReady / advance`）+ 末尾必插一次 `pttDown` 打断；打断也可出现在随机位置（`interruptPtt / interruptText`）。
- **运行次数：`numRuns = 1000`**。每条断言 5 条不变量。
- **发现的反例：无**（1000 次全过）。为验证测试有「牙齿」，我把模拟器 `stopAudio` 临时改成空操作再跑：属性测试与 7 个确定性用例**全部按预期失败**（报「音频仍在播放」等），随后已还原。

不变量与实现：
1. 打断执行完那一刻，D34 契约后置条件全部成立（音频停、反应音停、口型 closed、字幕 null、旧 turnId 命令数 0、剧情层命令数不变）——由 `interruptViolations` + 执行器断言。
2. 打断后旧 turnId 的字幕/视觉/音频事件出现次数为 0（喂入旧轮次 `beat / turn_end / BEAT_AUDIO_STARTED`，断言 A 的 `subtitle / visual` 引用不变）。
3. C 不倒退：`cRank(after) >= cRank(before)`，且 before 非 none 时 after 非 none（developing/ready/shown 保持不倒退）。
4. 镜头不动：打断前后 `visual.camera` 不变。
5. 音频不在播放时口型一定 closed（每一步之后都断言）。

7 个确定性用例（各一条）：思考中、反应音播放中、一句话说到一半、两句之间、解码中、显影中（断言 C 保持 `developing`）、主动开口中。

## 4. Q1 实测（Playwright）

- 用例：`e2e/stage.spec.ts` 用例 5，Mock 模式；`submitText` 进入 speaking → `pressPtt`（pointerdown）→ 从页面 `performance.getEntriesByType("mark")` 读 `interrupt:start / audioStopped / mouthClosed` 的 `startTime`。
- 断言两项耗时均 ≤150ms，并写入 `e2e/out/q1-timings.json`。
- 实测（连跑两次一致）：

  | 指标 | 数值 |
  |---|---|
  | `interrupt:start → interrupt:audioStopped` | **0.10ms** |
  | `interrupt:start → interrupt:mouthClosed` | **0.10ms** |

- 说明：数值是亚毫秒，因为有序执行器在 `pointerdown` 处理函数内**同步**完成（`AudioBufferSourceNode.stop()` 也是同步生效），全部发生在同一帧。相对「按下即静音 ≤150ms」的预算有极大裕量。只有在浏览器需等待音频解码/设备时才可能出现更多延迟，这里没有伪造数值。

## 5. 歧义与矛盾（含对授权的边界说明）

1. **`performanceClock.ts` 不在「授权修改」名单里，但 §3 要求移植「core 里所有延时触发的逻辑（含 nudge 计时）」**。处理：只改其**外壳接线**（节拍改由 `timeline` 单定时器驱动、nudge 计时改由 `timeline` 注册/取消），`createPerformanceClock` 纯逻辑与其全部既有测试保持原样。若要求连纯逻辑一起改，请明确。
2. **现有 `performanceClock.test.ts` 的「说话口型间隔」用例**测的是 `mouthDelayMs`。删除计时器轮换后 `mouthDelayMs` 在生产中已不再使用，但为遵守铁律 1（不改既有测试意图）我**保留**了该导出与用例，未删。宁可留一处「已无生产调用」的导出，也不擅动测试。
3. **授权新增文件只列了 4 个 src 文件 + 它们的测试**，但 §4 需要独立的矩阵属性测试、§2 需要 debug 环形缓冲区。处理：环形缓冲区放在授权文件 `core/timeline.ts` 内；只多了 `test/interruptMatrix.property.test.ts` 这一测试文件（e2e 用例写在既有 `e2e/stage.spec.ts`）。
4. **`interruptPlan(state)` 的入参**：计划本身与运行期状态无关（仅 `turnId` 用于标注每步），故实现为 `interruptPlan({ reason, turnId })`，`reason` 决定「清空」这一步 dispatch `PTT_DOWN` 还是 `SUBMIT_TEXT`（由外壳执行）。
5. **打断执行器在「非 idle」时才被调用**：`pttDown / submitText` 沿用既有判断（`wasActive`）；idle 下只做正常输入，不跑执行器、不发 `interrupt`。矩阵里也从 idle 触发的打断退化为普通输入。
6. **`AnalyserNode` 退路（120ms 交替）未被 e2e 覆盖**：无头 Chromium 有 `AnalyserNode`，该分支只在缺能力时触发；已用单测（`fallbackMouth`）覆盖其纯逻辑。
7. **`reactionSfx` 的定时器接口变化**：为保证反应音计时能按轮取消，`ReactionDeps.setTimer` 增了第 3 个形参 `turnId`。这是向后兼容的（既有测试的 2 参 `setTimer` 仍可赋值），故未改动 `reactionSfx.test.ts`。
8. **新依赖 `fast-check`**：客户端属性测试需要，已加入 `apps/client` devDependencies（服务端本就已用同版本 4.10.2），并更新 lockfile。
