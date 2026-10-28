# freeze-fix5 报告：语音合成失败时字幕一闪而过

> 执行：Command Code（deepseek-v4-flash）· 2026-10-28 · worktree `/Users/gjy/mira-wt-ff5`（分支 `freeze-fix5`）
> 冻结期只修这一个 bug。未 commit。

## 结论

TTS 失败时，服务端把该句降级为无声 beat（仍带台词文本、不再下发 `tts_audio`），并下发轮次级 `error{code:"tts_degraded", retryable:false}`。
原先客户端有两处问题：

1. 无声 beat 固定停留 `SILENT_BEAT_MS = 1_200`，且**降级句（say 非空、无音频）根本进不了无声路径**——`pickNextPlayable` 只把 `say === ""` 当无声，降级句会一直等音频；直到 `tts_degraded` 把本轮打成 `error` 态并清空队列，整轮回复一闪而过。
2. 客户端对 `tts_degraded` 无任何提示，观众不知道发生了什么。

修复后：TTS 降级是**非致命**的，本轮继续；降级句按可读时长（`silentBeatMs`，1.5–6s）停留，字幕区附近显示一行轻提示。

## 改动（§2）

| 文件 | 改动 |
| --- | --- |
| `apps/client/src/core/scheduler.ts` | 新增纯函数 `silentBeatMs(text)` + 常量 `SILENT_BEAT_MIN_MS=1500` / `SILENT_BEAT_MAX_MS=6000` / `SILENT_BEAT_MS_PER_CHAR=220`；新增 `isTurnTtsDegraded(state)`；`pickNextPlayable` 在本轮降级且该 beat 无音频就绪时按无声处理（不卡死）。 |
| `apps/client/src/core/audio.ts` | 删除固定常量 `SILENT_BEAT_MS`；无声 beat 的结束时刻改为 `timeline.now() + silentBeatMs(say)`（`say` 取自队列中该 seq 的台词）。 |
| `apps/client/src/state/types.ts` | `ClientState` 新增 `ttsDegradedTurnId: number | null`。 |
| `apps/client/src/state/reducer.ts` | `initialState` 增加该字段；`beginTurn` / `toIdle` / `markTurnEnded` 清除它；`applyServerMessage` 的 `case "error"` 对 `tts_degraded` 特判为**非致命**：只置 `ttsDegradedTurnId = message.turnId`，不改 phase、不 `toIdle`、不动 `audioStopToken`。 |
| `apps/client/src/view/useStageViewModel.ts` | `StageView` 新增 `ttsDegraded: boolean`；`toStageView` 用 `isTurnTtsDegraded(stage)` 计算（仅当 `ttsDegradedTurnId === currentTurnId`）。 |
| `apps/client/src/live/uiText.ts` | 新增 `UI_TEXT.ttsDegradedHint = "语音暂时出不来，先看字幕吧"`。 |
| `apps/client/src/live/Live.tsx` | `SubtitleBox` 增加 `ttsDegraded` 入参并在字幕下方渲染提示；手机布局在字幕上方渲染同样提示。**未改动 PTT 按钮相关代码。** |
| `apps/client/src/live/live.css` | `.live-tts-degraded-hint`（复用琥珀色 `--think`，不新建视觉风格）+ `.live-tts-degraded-hint-mobile`（绝对定位，贴手机字幕上方、含 safe-area）。 |

## 测试（§3）

新增：

- `apps/client/test/silentBeat.test.ts`（7）
  - `silentBeatMs`：空串 / 纯标点 / 纯空白 → 下限 1500；短句取下限；中间线性（10 字 2200、15 字 3300）；长句取上限 6000；标点与空白不计（`"一二三四五，六七八九十。"` == `"一二三四五六七八九十"`）；随字数单调不减且始终 ∈ [1500, 6000]。
  - 无声 beat 调度：用 `createTimeline` 外壳断言结束时刻 = `silentBeatMs(say)`（差 1ms 不触发、正好到点触发）。
- `apps/client/test/ttsDegraded.test.ts`（5）
  - 收到当前轮 `tts_degraded` → `ttsDegradedTurnId === 1` 且视图 `ttsDegraded === true`；
  - 非致命：phase 保持不变（非 error）、`audioStopToken` 不变；
  - `turn_end` → 提示消失；下一轮（`SUBMIT_TEXT`）→ 提示消失；
  - 旧 turnId 的迟到 `tts_degraded` → 状态不变、不显示（D3）。
- `apps/client/test/scheduler.test.ts`（+2，共 9）
  - 本轮降级 → 未就绪的 beat 也按 silent 返回；有音频就绪时仍走正常路径；
  - 旧轮的降级标记不影响当前轮（只比对 `currentTurnId`）。

结果：

- `pnpm test`：**1062 passed / 109 files**（红→绿：改动前新建测试 12 条全失败）。
- `pnpm typecheck`：全部 Done。
- `pnpm smoke`：**SMOKE OK**（含 `faults:["tts"] → turn_end(done)`：该轮 3 个 beat、0 条 tts_audio、有 `tts_degraded`）。

## 歧义与判断（说明假设）

1. **`tts_degraded` 是否致命**：§2 只写了「新增纯函数」与「显示提示」，未显式说改错误路径。但不改的话，`tts_degraded` 会把客户端打进 `error` 态并清空队列（`reducer` 的 `case "error"` 原先对所有轮次级 error 一视同仁），提示会被错误界面顶掉，且服务端在降级后仍照常下发 `turn_end{reason:"done"}`——语义上一轮是**正常结束**的。故按「非致命降级」处理：不改 phase、不清空本轮。已用 `pnpm smoke` 的 tts 段核对服务端确实是 `turn_end(done)`。
2. **降级句如何进入无声路径**：§1 说「客户端无声 beat 固定 1.2s」，暗示降级句走了无声路径；但现网 `pickNextPlayable` 只把 `say === ""` 当无声，降级句 `say` 非空且无音频，会一直等。为让 §2.1 的 `silentBeatMs(text)` 真正被调用（§4 契约「随字数单调不减」也要求传入的是台词文本），在 `pickNextPlayable` 增加「本轮降级且无音频就绪 → 按 silent」分支。这是达成 §1/§4 的必要环节，最小改动，未引入新协议或新视觉风格。
3. **提示文案**：按任务给的定稿 `语音暂时出不来，先看字幕吧` 写入 `uiText.ts`，未自拟。
4. **样式**：复用兜底字幕的琥珀色调（`--think`），未新建视觉风格。
5. **未打开任何图片；未跑 e2e；未 commit；未触碰 `tools/live2d-pipeline/**`、`skills/**`、`Live.tsx` 的 PTT 按钮代码。** 本次未启动任何 dev server，无进程需要清理。

## 续修（Claude 验收：整轮卡在 speaking）

### 缺陷

原实现里 `markTurnEnded`（收到 `turn_end` 时）会清掉 `ttsDegradedTurnId`。但服务端 TTS 失败很快，`turn_end` 常在本轮**第一句无声 beat 还在播**时就到达。此时清标记 → `isTurnTtsDegraded` 变 false → `pickNextPlayable` 对队列里剩余的降级句（`say` 非空、无音频就绪）返回 `null` → 整轮卡死在 `speaking`，后面几句永远不播。同时提示也会在还剩几句没播时就提前消失。

### 修法（最小改动）

- `apps/client/src/state/reducer.ts`：`markTurnEnded` **不再**清 `ttsDegradedTurnId`；标记只在 `beginTurn`（下一轮开始）与 `toIdle`（本轮真正播完回 idle）清除。即提示的语义改为「本轮播完回 idle 时消失」（原为「`turn_end` 时消失」）。`turn_end` 只置 `turnEnded`，与既有的「等最后一个 `BEAT_AUDIO_ENDED` 再回 idle」规则一致。
- 其余文件（`scheduler.ts` / `audio.ts` / `types.ts` / `useStageViewModel.ts` / `uiText.ts` / `Live.tsx` / `live.css`）不动。

### 测试

- `apps/client/test/ttsDegraded.test.ts`：
  - 原「`turn_end` → 提示消失」改为「回到 idle（本轮播完）→ 提示消失；`turn_end` 本身不清除」——**只改断言时机，不改意图**（仍未显示 / 消失的真实条件变了）。构造 `speaking`（第 1 句已在播）再依次 `turn_end`（提示仍在）、`BEAT_AUDIO_ENDED`（回 idle、提示消失）。
  - 新增回归测试「turn_end 在第 1 句播放中到达 → 3 句都按 `silentBeatMs` 播完并回到 idle」：按 `audio.ts` 的调度方式（`pickNextPlayable` → `BEAT_AUDIO_STARTED` → 停留 `silentBeatMs(say)` → `BEAT_AUDIO_ENDED`）跑 3 句降级 beat，`turn_end` 在第 1 句播放中到达；断言 3 句都播放、时长都等于 `silentBeatMs(对应台词)`、最终 `phase.kind === "idle"` 且提示消失。
- 红→绿核对：临时把 `markTurnEnded` 改回清标记，上述新测试与改后的提示测试**均失败**（分别命中 `hint` 提前消失、`pickNextPlayable` 返回 `null`），还原修复后全绿。

结果（续修后）：

- `pnpm test`：**1063 passed / 109 files**（较原 1062 多 1 条新增回归测试）。
- `pnpm typecheck`：全部 Done。
- `pnpm smoke`：**SMOKE OK**（`faults:["tts"] → turn_end(done)` 段正常）。

### 判断

- **为何不在 `turn_end` 清**：`turn_end` 到达 ≠ 本轮播放结束。服务端语义是「本轮不再产生新 beat」，客户端仍需把已入队 / 已在播的降级句播完。故清除点必须落在「回 idle」，与 `toIdle` 的既有清理语义一致。
- **`thinking && queue 为空` 的 `turn_end`**：仍走 `toIdle`（本轮没有任何 beat），会清标记——这是正确的（没有 beat 可播，直接回 idle），不受本次改动影响。
- **未 commit；未跑 e2e；未打开图片；未启动 dev server。**
