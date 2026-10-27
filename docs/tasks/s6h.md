# S6h 任务说明：观测页（延迟 / 错误 / 模型调用）

> 用户 2026-10-28 要求派发。关卡 1–5 结论由 Claude 决定（见末尾）。执行者：Command Code（Kimi-K3）。
> 与 S6c、S6f 并行（各自的 worktree）。`apps/server/src/index.ts`、`apps/client/src/main.tsx` 别的批次也在改：**只加接线，不重排既有代码**，方便合并。

## 铁律
冲突停下写进报告；Key 只从 `.env` 读取、不得打印；**观测数据里不得出现用户输入的文字、台词、提示词、Key**；不准 commit；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片；长命令显式传大 timeout，同一命令超时两次就停下写进报告。

## 授权范围
新增 `apps/server/src/obs/**`、`apps/client/src/obs/**`、对应测试、e2e `e2e/obs.spec.ts`、`docs/tasks/s6h-report.md`；`index.ts` 只加「logger 旁路写入环形缓冲」和一条 HTTP 路由；`main.tsx` 只加 `?obs=1` 路由；直播间只加一个可选的小角标（§3）。

## 背景
服务端 `log.ts` 已经每个事件输出一行 JSON：`{ ts, sessionId?, turnId?, event, ms?, detail? }`。现有事件包括 `turn_start / stt_done / llm_first_beat / tts_first_audio / tts_done / playback_started / beat_sent / turn_end / turn_aborted / turn_failed / stale_turn / fallback_used / media_scheduled / media_ready_sent / media_failed / quota_exceeded / session_created / session_resumed / provider_fallback …`（以代码为准，先 grep 全部事件名）。本批**不新增业务埋点**，只做收集、汇总、展示；确实缺关键耗时时，可以在已有事件上补 `ms` 字段，并写进报告。

## §1 服务端：环形缓冲 + 汇总（纯函数为核心）
- `createObsBuffer(capacity = 2000)`：logger 每条记录先过 `sanitize(record)` 再进缓冲。`sanitize` 只保留 `ts / sessionId / turnId / event / ms` 和 `detail` 里的**白名单数值或枚举字段**（如 `code`、`port`、`provider`、`status`、`bytes`），其余一律丢掉。
- 纯函数 `summarize(records, now)` 产出：
  1. **最近 20 轮的阶段时间线**：每轮 `turn_start` 起算的各阶段相对时间（STT 完成、LLM 首句、TTS 首包、开始播放、结束），以及结束原因（done / interrupted / error）。
  2. **阶段耗时分布**：上面每个阶段的 p50 / p95 / 最大值 / 样本数；重点是**首包延迟**（turn_start → tts_first_audio）。
  3. **错误与兜底**：按 `event` + `code` 计数（最近 5 分钟、全部）。
  4. **模型调用**：按端口（stt / llm / tts / image）统计次数、失败数、平均耗时。
- `GET /obs/summary` 返回 `summarize()` 的 JSON。环境变量 `OBS_ENABLED`（缺省开启，`0` 关闭；关闭时路由 404）。

## §2 客户端：`?obs=1` 观测页
- 独立路由，每 2 秒拉一次 `/obs/summary`；不连 WebSocket、不影响直播间。
- 四块：最近 20 轮的瀑布条（每轮一行，阶段用不同颜色，打断/失败标红）；阶段耗时表（p50/p95/max）；错误与兜底计数；模型调用表。
- 空数据时显示「还没有互动，去直播间说句话」类的占位（文字放 `uiText`，不要硬编码在组件里）；接口失败时显示「观测接口不可用」且继续重试。
- 手机宽度可用（表格可横向滚动在卡片内部，页面本身不能横向滚动）。

## §3 直播间首包延迟角标（可选显示）
- URL 带 `?hud=1` 时，直播间角落显示上一轮的「首包 xxx ms」；数据来自客户端自己测的「发出输入 → 第一段音频开始播放」（`performance.now()`），不依赖服务端。默认不显示。

## §4 测试
- `sanitize`：fast-check 属性测试——任意 `detail`（含字符串、嵌套对象、像 Key 的串）进去，出来的记录里不会有非白名单字段、不会有任何字符串长度 > 40 的值。
- `summarize`：构造乱序、缺阶段、被打断、重复 turnId 的记录，断言时间线和分位数正确；空输入不报错。
- 路由：`OBS_ENABLED=0` 时 404；正常时返回合法 JSON。
- e2e（`E2E_SERVER_PORT=8988 E2E_CLIENT_PORT=5374`，避开 S6c/S6f）：Mock 模式说一句话后打开 `?obs=1`，断言出现 1 行时间线；截图 `e2e/out/s6h-obs.png`（你不用看图）。
- `pnpm test`、`pnpm typecheck` 全绿。

## §5 报告 `docs/tasks/s6h-report.md`
改动文件、白名单字段清单、各阶段对应哪些事件、补了哪些 `ms`、测试结果、可能与 S6c/S6f 冲突的文件。

## 关卡 1–5 结论（Claude 决定）
1. **YAGNI**：内存环形缓冲，不接 Prometheus/数据库，不做历史持久化；页面轮询，不做推送。
2. **端口/适配器**：缓冲是 logger 的一个旁路接收者，不改任何业务模块的调用方式。
3. **函数式核心**：`sanitize` 和 `summarize` 是纯函数（时间由参数传入），路由和页面只做外壳。
4. **契约式设计**：后置条件——观测数据只含白名单字段，绝不含文本内容和 Key；`summarize` 对任意输入不抛错。
5. **测试奖杯**：纯函数单测 + 属性测试为主，一条 e2e 兜整体。
