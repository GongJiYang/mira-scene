# S3 修复轮执行报告（s3-fix.md）

> 铁律与授权范围同 `docs/tasks/s3.md`。本批**未** `git commit`；**未**改动 `tools/`、`docs/architecture/`、
> 客户端调度器/reducer 既有规则；日志与错误信息中未出现任何 Key；无遗留常驻进程。

## 结论速览

| 命令 | 结果 |
|---|---|
| `pnpm test` | ✅ **336 passed**（基线 327 + 新增 9） |
| `pnpm typecheck` | ✅ 4 个 workspace 全部通过 |
| `pnpm smoke` | ✅ SMOKE OK（mock，行为与之前一致） |

## 1. 逐条落实

### §1 `parseBeatLines`：坏行不再把 JSON 符号送进 TTS
`apps/server/src/adapters/deepseek/parseBeatLines.ts` 改成只对 **`JSON.parse` 失败**的行套用修复规则，
顺序与任务一致：

1. **① 粘连拆段**：以 `{` 开头 → 按 `}\s*{`（允许中间空白）拆开，逐段走「先 `JSON.parse`，失败再降级」。
2. **② 正则提取**：用 `"say"\s*:\s*"((?:[^"\\]|\\.)*)"` 提取台词，`"emotion"` 存在则一并提取，得到一个 beat。
3. **③ 疑似 JSON 丢弃**：以 `{`/`[` 开头或含 `":` 且 ①②都失败 → 丢弃，只写 warning。
4. **④ 纯文本降级**：完全不像 JSON 的文本才降级为 `{say, emotion:"neutral"}`。

> `JSON.parse` 成功但不是对象（数组/原始值）的行**沿用既有行为**（降级为纯台词），
> 这样既满足「一行解析失败时」的修复范围，又保持原测试 `非对象的 JSON 行（数组/数字）也降级为纯台词` 的意图不变。

### §2 `advanceRule`：「进入 reveal 两轮之后」才允许 ending
- `packages/protocol/src/scene.ts`：`SceneState` **只新增可选字段** `revealTurn`（进入 reveal 时的轮次）。
- `apps/server/src/prompts/advanceRule.ts`：`reveal` 分支改为 `turnCount - revealTurn >= 2`；
  **没有 `revealTurn` 时不允许 ending**。
- `apps/server/src/director/director.ts`：进入 reveal 的那一刻写入 `revealTurn: scene.turnCount`
  （`advanceScene` 之后、`applyBeatToScene` 之前，一行）。

### §3 `paceGuard`：第一句不重试
- `apps/server/src/ports.ts`：`synthesize` 的 opts 抽出为 `TtsOptions`，**新增可选** `beatSeq`。
- `apps/server/src/session.ts`：调用 TTS 时传入 `beatSeq: seqBeat.seq`（由会话层传入）。
- `apps/server/src/quality/paceGuard.ts`：`opts.beatSeq === 0` 时超出范围只检查、写
  `tts_pace_warning{reason:"first_beat_no_retry"}` 并**不重试**；第二句及以后维持原逻辑。

### §4 小问题
- **意图识别搬迁**：`classifyIntent` / `Intent` 从 `adapters/mock/mockLlm.ts` 挪到新增的
  `apps/server/src/intent.ts`；`mockLlm.ts`、`prompts/renderPrompt.ts`、`prompts/advanceRule.ts`
  都改为从 `../intent` import（核心模块不再依赖 Mock 适配器）。
- **STT 日志脱敏**：`session.ts` 的 `stt_done` 由 `{ text: userText }` 改为 `{ chars: [...userText].length }`（字数）。
- **`fishTts` 余额标记**（行为说明，见下）：
  `apps/server/src/adapters/fish/fishTts.ts` 把布尔标记换成「下次允许探测的时间点」——
  - 收到 402（`fish_credit`）后，置 `creditExhaustedUntil = now + 5min`；间隔内直接抛错、**不再发请求**；
  - **每 5 分钟允许探测一次真实请求**；
  - **成功请求一次之后自动清除标记**（`creditExhaustedUntil = 0`），之后立刻恢复正常请求。
  - 新增注入项：`creditProbeIntervalMs`（默认 `CREDIT_PROBE_INTERVAL_MS = 5min`）、`now`（默认 `Date.now`），便于单测。

## 2. 改动的文件

| 文件 | 改动 |
|---|---|
| `apps/server/src/intent.ts` | **新增**：`Intent` / `classifyIntent`（从 mockLlm 迁出） |
| `apps/server/src/adapters/deepseek/parseBeatLines.ts` | 坏行处理 ①②③④ 重写 |
| `apps/server/src/adapters/mock/mockLlm.ts` | 改为 import `../intent`（删除本地定义） |
| `apps/server/src/prompts/advanceRule.ts` | reveal→ending 改由 `revealTurn` 判定；import 改 `../intent` |
| `apps/server/src/prompts/renderPrompt.ts` | import 改 `../intent` |
| `apps/server/src/director/director.ts` | 进入 reveal 时写 `revealTurn`（一行） |
| `apps/server/src/ports.ts` | `TtsOptions` 抽型 + 新增可选 `beatSeq` |
| `apps/server/src/session.ts` | 传 `beatSeq`；`stt_done` 改记 `chars` |
| `apps/server/src/quality/paceGuard.ts` | `beatSeq===0` 不重试 |
| `apps/server/src/adapters/fish/fishTts.ts` | 余额标记：成功后清除 + 5 分钟探测窗口 |
| `packages/protocol/src/scene.ts` | **只新增**可选字段 `revealTurn` |
| `apps/server/test/parseBeatLines.test.ts` | 新增 4 个用例 + 1 个属性测试 |
| `apps/server/test/prompts.test.ts` | 更新 reveal→ending 用例 + 新增第 8/9/10 轮用例 |
| `apps/server/test/paceCheck.test.ts` | 新增 seq0 / seq1 用例 |
| `apps/server/test/fish.test.ts` | 新增余额探测与清除用例 |
| `apps/server/test/mockLlm.test.ts` | `classifyIntent` / `Intent` 改从 `../src/intent` import |

> 未改 `state/reducer.ts`、`core/scheduler.ts` 既有规则；未改 `tools/`。

## 3. 新增测试（9 个）

| 文件 | 测试 |
|---|---|
| `parseBeatLines.test.ts` | ① 粘连 `}{` 拆段；② 正则提取 say/emotion；③ 疑似 JSON 丢弃（截断 / 无 say / 含 `":`）；④ 纯文本降级 |
| `parseBeatLines.test.ts` | **属性测试（600 次）**：随机 JSON 行 / 粘连行 / 截断行 / 纯文本行 → 输出的任何 `say` **不含 `{"` 或 `":`** |
| `prompts.test.ts` | 「进入 reveal 两轮之后才允许 ending；没有 `revealTurn` → 不允许」；「第 8 轮进入 reveal → 第 9 轮不允许、第 10 轮允许」 |
| `paceCheck.test.ts` | `beatSeq=0` 超出范围 → 只请求 1 次并写 warning；`beatSeq=1` 超出范围 → 请求 2 次 |
| `fish.test.ts` | 402 后间隔内不发请求；满 5 分钟探测一次；成功后清除标记并立即恢复 |

## 4. 测试输出摘要

```
pnpm test  →  Test Files 31 passed (31)   Tests 336 passed (336)
             （含属性测试：parseBeatLines 600 次；director.property 500 次 × 50–200 beat）
pnpm typecheck → packages/protocol ✓  apps/server ✓  apps/client ✓  tools/probes ✓
pnpm smoke     → SMOKE OK
   hello → session 3ms；turn1 → 首个 beat 1ms；turn2 → turn_end(done) 605ms；
   重复 turnId → stale_turn 1ms；ping → pong 0ms；faults:["tts"] → turn_end(done) 610ms
```

## 5. 发现的说明歧义 / 冲突（已按「修复说明 > 旧测试」处理并保持意图）

1. **`prompts.test.ts` 的旧 reveal 用例**：旧断言 `advanceRule({node:"reveal"}, "other", 4) === ALLOW_ENDING`
   依赖已被 §2 移除的全局轮次近似。已把夹具补上 `revealTurn`（`revealTurn: 2` 时 turnCount 4 允许、3 不允许），
   **意图「进入 reveal 两轮后可 ending」保持不变**，并按任务新增「第 8/9/10 轮」与「无 revealTurn 不允许」用例。
2. **`非对象的 JSON 行（数组/数字）也降级为纯台词`**：任务 §1 的规则限定在「一行 `JSON.parse` 失败时」，
   该行的 `JSON.parse` 是**成功**的，故沿用旧行为，测试未改。
3. **`revealTurn` 的写入位置**：授权范围未列出 `director.ts`；但「进入 reveal 时的轮次」在导演层的
   `advancedTo === "reveal"` 分支才能唯一确定（`session.ts` 只允许改提示词上下文/计时/`playback_started`），
   故在 `director.ts` 写一行。若不接受对 `director.ts` 的改动，请指示。
4. **`fishTts` 探测与调用上限**：5 分钟探测窗口下，一次冒烟进程内仍会在 402 后停止发请求，
   不会刷爆 §9 的 `TTS ≤8`；跨进程/长时间运行则每 5 分钟最多多一次探测请求。

## 6. 安全 / 约束自查

- Key 仅从仓库根 `.env` 读取，且只有 `real` 模式才读；未打印、未落日志、未写入文件；错误信息不含 Key。
- 测试全部使用假 `fetch`，不联网、不读真实 Key；属性测试仅做纯函数计算。
- `PROVIDER_MODE=mock`（默认）行为不变：`pnpm smoke` 通过，原有测试意图保持不变。
- 未执行 `git commit`；未触碰 `tools/`；无遗留常驻进程。
