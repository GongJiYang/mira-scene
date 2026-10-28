# freeze-fix6 报告：情景化兜底台词卡死

> 任务：`docs/tasks/freeze-fix6.md`（§1–§4）。冻结期只修这一个 bug。未 commit。

## 结论

修好。`/?fail=llm_timeout` 发一条弹幕 → 约 10s 后字幕出现角色包 `llm_timeout` 台词，并回到 idle。
`pnpm test`（110 文件 / 1073 用例）、`pnpm typecheck`、`pnpm smoke` 全绿；§3 指定的 e2e
`e2e/fallback-unstuck.spec.ts`（desktop）通过。

## 改动

### 客户端 · 通用兜底规则（§2.1）
- `apps/client/src/core/scheduler.ts`：`pickNextPlayable` 增加分支——本轮已收到 `turn_end`
  （`state.turnEnded === true`）且该 beat 无音频就绪 → 按无声 beat 处理（时长走 freeze-fix5 的
  `silentBeatMs(say)`）。服务端保证 `turn_end` 之前发完全部 `tts_audio`，故正常轮不受影响。
  条件与 TTS 降级分支并列：`isTurnTtsDegraded(state) || state.turnEnded`。
- `apps/client/src/state/reducer.ts`：把轮次级「兜底」错误码 `llm_timeout` / `turn_failed`
  视为**非致命**。收到它们时不清空本轮 `queue` / `subtitle`、不进入 `error` 相位，只置
  `turnEnded: true`，让兜底 beat 播完再回 idle（原始报错只在 `?debug=1` 显示，符合 D40）。
  - **说明**：这一条超出 §2 的字面范围，但为满足 §3 的 e2e 所必需，已与用户确认后实施（见「歧义/冲突」）。

### 服务端 · 兜底 beat 配预录语音（§2.2）
- `apps/server/src/session.ts`：
  - 新增 `fallbackVoiceUrl(id, category)` 与 `readFallbackAudio(root, id, category)`：按
    `<root>/characters/<id>/voice/fallback/<category>.mp3` 读取；文件不存在 / 读失败 → `null`。
  - `SessionDeps` 新增 `fallbackVoiceRoot?`（缺省 `clientPublicRoot()`；测试注入空目录以覆盖「缺失」分支）。
  - `runTurn` 内新增 `emitFallbackAudio(category)`：写日志 `fallback_audio { category, found }`
    （不含路径以外的敏感信息），存在则 `emitFinal("tts_audio", { beatSeq: 0, mime: "audio/mpeg", dataBase64 })`。
  - 四个兜底调用点（`stt_empty` / `stt_failed` / `llm_timeout` / `turn_failed`）都在发出兜底 beat 后、
    `turn_end` 之前调用它。Mock 与真实同一路径。

## 测试

新增 / 修改：
- `apps/client/test/scheduler.test.ts`（新增 3 例）：`turnEnded` 且无音频 → silent；
  `turnEnded` 为 false 且无音频且未降级 → 仍 null；有音频就绪 → 非 silent。
- `apps/client/test/reducer.test.ts`（改 3 例、新增 3 例）：
  - 新增「兜底整轮：beat → error(llm_timeout) → turn_end → 播完回 idle」。
  - 新增 `it.each(["llm_timeout","turn_failed"])`：当前轮兜底 error 不清空本轮、不进错误态。
  - 原「当前轮的轮次级 error 进入错误态」「error 清空 queue/subtitle」「RETRY 回到 idle」改用
    非兜底 code（`quota_exceeded` / `stale_turn` / `real_unavailable`）保留原语义。
- `apps/server/test/fallbackAudio.integration.test.ts`（新增）：`llm_timeout` 顺序为
  `beat → tts_audio(beatSeq 0) → turn_end` 且 `fallback_audio{found:true}`；空根目录 → 只有
  `beat → turn_end` 且 `found:false`；`stt_empty` 同样配预录语音。
- `apps/server/test/faults.test.ts`（改 2 例）：`llm_timeout` / `stt_empty` 的顺序断言补上 `tts_audio`。
- `e2e/fallback-unstuck.spec.ts`（新增，仅 desktop）：`/?fail=llm_timeout` 发一条弹幕 → 25s 内
  字幕出现 `llm_timeout` 台词 → 回到 idle（`state-chip data-tone="idle"`）。

命令与结果：
- `pnpm test` → 110 files / 1073 tests 全过。
- `pnpm typecheck` → 全过。
- `pnpm smoke` → SMOKE OK。
- `pnpm exec playwright test e2e/fallback-unstuck.spec.ts --project=desktop` → 1 passed。

## 歧义 / 冲突

1. **§2 与 §3 的冲突（已与用户确认后处理）**：§2 只列出「客户端 `pickNextPlayable` 兜底规则 +
   服务端配预录语音」两层。两层都做完后，e2e 仍失败——因为客户端现有（且有单测锁定）行为是：收到
   `error{llm_timeout}` 立即清空本轮 `queue` / `subtitle` 并进入 `error` 相位，兜底 beat 根本来不及显示。
   §1 对现象的描述是「客户端一直停在 think……约 40s 后才回 idle」，与现状（10s 即进入 error 相位）
   并不一致，属任务说明与代码现实的偏差。
   - 处理：按用户裁定「按 e2e 目标，让兜底错不再清空 beat」，在 reducer 里把 `llm_timeout` /
     `turn_failed` 视为非致命，仅置 `turnEnded`。副作用：这两类错误不再显示错误态（原始报错本就只在
     `?debug=1` 显示，符合 D40），且 `turn_failed` 的 `retryable` 在 UI 上不再可重试。
2. **§1 与 §3 对下行顺序的表述**：§1/§3 均把兜底序列写成「beat → tts_audio → turn_end」，省略了
   中间实际存在的 `error{llm_timeout}`。本实现保留该 error（协议不变），仅让其非致命。
3. **无声兜底的时长**：按 §2 使用 freeze-fix5 的 `silentBeatMs(say)`；兜底台词通常较短，实际落在
   1.5s 下限附近，符合可读下限。

## 未做 / 边界

- 不改任何台词；不新增兜底类别；协议结构未变。
- 未碰 `tools/live2d-pipeline/**`、`skills/**`；未打开图片；未 commit。
- e2e 只跑了 §3 指定的这一个 spec。
