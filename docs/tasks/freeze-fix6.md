# freeze-fix6 任务说明：情景化兜底台词卡死（真实 / Mock 都受影响）

> 来源：2026-10-28 Claude 复现。执行者：Command Code（deepseek-v4-flash）。冻结期：只修这一个 bug。

## 铁律
冲突停下写进报告，不许绕过；Key 规则见 CLAUDE.md（D49）；**不准 commit**；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要打开任何图片；长命令显式 timeout；测试不发真实网络请求；**只准停自己启动的进程，禁止 `pkill -f vite` 这类宽匹配**；e2e 只跑 §3 指定的 spec。先写会失败的测试再改。不改台词。

## §1 现象与根因（已复现）
- `/?fail=llm_timeout` 发一条弹幕：服务端第 10s 下发兜底 beat（`fallbackBeat`，`say` 为角色包 fallback 台词）并立即 `turn_end`；**客户端一直停在 think，字幕只有「...」，兜底台词从未显示**，约 40s 后才回 idle。
- 根因：服务端兜底 beat（`stt_empty` / `stt_failed` / `llm_timeout` / `turn_failed`，见 `apps/server/src/session.ts` 的 `fallbackBeat` 调用点）**只有文字、不发 `tts_audio`**；客户端 `apps/client/src/core/scheduler.ts` 的 `pickNextPlayable` 对 `say` 非空、无音频就绪、且本轮未 TTS 降级的 beat 返回 `null`，永远等音频。
- 预录兜底语音已存在：`apps/client/public/characters/yuna/voice/fallback/<category>.mp3`（stt_empty、stt_failed、llm_timeout、turn_failed 等）。

## §2 修法（两层，都要做）
1. **客户端通用兜底规则（防卡死）**：`pickNextPlayable` 增加：本轮已收到 `turn_end`（`state.turnEnded === true`）且该 beat 无音频就绪 → 音频不会再来，按无声 beat 处理（时长用 freeze-fix5 的 `silentBeatMs(say)`）。服务端在 `turn_end` 之前发完全部 `tts_audio`，此规则不影响正常轮。
2. **服务端给兜底 beat 配预录语音**：发兜底 beat 后、`turn_end` 之前，若角色包对应的预录文件存在（复用现有解析客户端静态资源路径的工具与角色 id），读取并下发 `tts_audio { beatSeq: 0, mime: "audio/mpeg", dataBase64 }`；文件不存在 → 不发（由第 1 层按无声兜底）。Mock 与真实模式同一路径。日志 `fallback_audio { category, found }`（不含路径以外的敏感信息）。

## §3 测试
- 客户端单测：`turnEnded` 且无音频 → `pickNextPlayable` 返回 silent；`turnEnded` 为 false 且无音频且未降级 → 仍 null（正常轮不受影响）；有音频就绪 → 非 silent。
- 服务端集成测试：`llm_timeout` 故障（用假时钟或缩短超时的现有测试方式）→ 下发顺序为 beat → tts_audio(beatSeq 0) → turn_end；预录文件缺失的类别 → 只有 beat → turn_end。
- e2e（只跑这一个）：新增 `e2e/fallback-unstuck.spec.ts`（desktop，Mock 服务由 playwright 配置启动）：打开 `/?fail=llm_timeout` 发一条弹幕 → 25s 内字幕出现角色包 `llm_timeout` 台词，且随后回到 idle（state-chip `data-tone="idle"`）。命令：`pnpm exec playwright test e2e/fallback-unstuck.spec.ts --project=desktop`（显式 timeout 600000）。
- `pnpm test`、`pnpm typecheck` 全绿，`pnpm smoke` 通过。

## §4 报告
`docs/tasks/freeze-fix6-report.md`：改动、测试名、歧义。

## 关卡 1–5 结论（Claude 决定，修复）
1. YAGNI：只修兜底卡死与兜底配音；不改兜底台词、不加新类别。
2. 端口/适配器：服务端在 session 外壳读静态文件；客户端只改调度纯函数。
3. 函数式核心：`pickNextPlayable` 仍是纯函数，新增分支有单测。
4. 契约：`turn_end` 之后不会再有 `tts_audio`；因此「已结束 + 无音频」必然按无声播完，任何 beat 都不会永久卡住。
5. 测试奖杯：纯函数单测 + 服务端集成测试 + 一个 e2e。
