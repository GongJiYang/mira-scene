# freeze-fix5 任务说明：语音合成失败时字幕一闪而过

> 来源：2026-10-28 正式录屏 `?fail=tts` 段。执行者：Command Code（deepseek-v4-flash）。冻结期：只修这一个 bug。

## 铁律
冲突停下写进报告，不许绕过；Key 规则见 CLAUDE.md（D49）；**不准 commit**；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要打开任何图片；长命令显式 timeout；测试不发真实网络请求；**只准停自己启动的进程，禁止 `pkill -f vite` 这类宽匹配**；不跑 e2e。先写会失败的测试再改。**不要改 `apps/client/src/live/Live.tsx` 里 PTT 按钮相关代码**（freeze-fix4 正在并行修改）。

## §1 现象与根因（已核实）
- TTS 失败时服务端把该句降级为无声 beat（D20），并下发 `error { code: "tts_degraded" }`。
- 客户端 `apps/client/src/core/audio.ts` 无声 beat 固定 `SILENT_BEAT_MS = 1_200`，不论句子长短都只显示 1.2s；客户端对 `tts_degraded` 没有任何提示。录屏里整轮回复一闪而过，读不完，观众也不知道发生了什么。

## §2 修法
1. 新增纯函数 `silentBeatMs(text: string): number`：按可读速度计算（中文按字数，约 220ms/字；标点、空白不计），下限 1_500ms、上限 6_000ms。无声 beat 的结束时刻改用它（替换固定常量）。
2. 客户端收到 `tts_degraded`：在字幕区附近显示一行轻提示，文案放 `apps/client/src/live/uiText.ts` 新键 `ttsDegradedHint`，内容由 Claude 定稿：`语音暂时出不来，先看字幕吧`；样式复用现有兜底字幕的琥珀色调（不新建视觉风格）；本轮结束（turn_end）或下一轮开始时消失；只对当前 turnId 生效（迟到的旧轮 error 不显示，遵守 D3）。

## §3 测试
- `silentBeatMs` 单测：短句取下限、长句取上限、中间线性、标点不计。
- 无声 beat 调度：用现有时间线测试方式断言结束时刻 = `silentBeatMs(say)`。
- 提示显隐：收到当前轮 `tts_degraded` → 显示；turn_end → 消失；旧 turnId 的 → 不显示。
- `pnpm test`、`pnpm typecheck` 全绿，`pnpm smoke` 通过。

## §4 报告
`docs/tasks/freeze-fix5-report.md`：改动、测试名、歧义。

## 关卡 1–5 结论（Claude 决定，修复）
1. YAGNI：只改无声 beat 时长与一行提示。
2. 端口/适配器：只动客户端核心调度与视图，协议不变（`tts_degraded` 已存在）。
3. 函数式核心：`silentBeatMs` 纯函数；提示显隐走 reducer / store 现有模式。
4. 契约：无声句显示时长 ∈ [1.5s, 6s] 且随字数单调不减；提示只属于当前轮。
5. 测试奖杯：单测为主，不跑 e2e。
