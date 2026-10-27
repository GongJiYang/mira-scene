# S6h 报告：观测页（延迟 / 错误 / 模型调用）

> 执行者：Command Code（Kimi-K3）。分支 `s6h-obs`，worktree `/Users/gjy/mira-wt-s6h`。
> 上一会话因接口限流中途退出，本会话先核对已有改动、补齐缺口（类型错误、路由测试、e2e、`duration_ms` 汇总），未推倒重来。
> **未 commit**（铁律）。未触碰 `tools/live2d-pipeline/**`、`skills/**`，未打开任何图片文件，Key 只从 `.env` 读取、未打印。

## 1. 改动文件

### 新增
| 文件 | 作用 |
| --- | --- |
| `apps/server/src/obs/sanitize.ts` | 纯函数 `sanitize(record)`：只留白名单字段 |
| `apps/server/src/obs/buffer.ts` | `createObsBuffer(capacity=2000)` 内存环形缓冲（logger 旁路接收者） |
| `apps/server/src/obs/summarize.ts` | 纯函数 `summarize(records, now)`：时间线 / 分位数 / 错误计数 / 模型调用 |
| `apps/server/test/obsSanitize.test.ts` | sanitize 属性测试 + 单测 |
| `apps/server/test/obsSummarize.test.ts` | summarize 单测 |
| `apps/server/test/obsRoute.test.ts` | `GET /obs/summary` 路由测试（本会话新增） |
| `apps/client/src/obs/ObsApp.tsx` | `?obs=1` 观测页（每 2 秒轮询） |
| `apps/client/src/obs/obsText.ts` | 观测页文案（不硬编码在组件里） |
| `apps/client/src/obs/obs.css` | 观测页样式（卡片内横向滚动，页面不横滚） |
| `apps/client/src/obs/hud.ts` | `?hud=1` 首包延迟角标状态 + `recordFirstAudioMs` |
| `e2e/obs.spec.ts` | 观测页端到端（本会话新增） |

### 修改（只加接线，不重排既有代码）
| 文件 | 改动 |
| --- | --- |
| `apps/server/src/index.ts` | `logger` 旁路写入 `createObsBuffer().push()`；新增 `GET /obs/summary` 路由（`OBS_ENABLED=0` → 404，放在 `/generated/` 之前，不遮蔽既有路由） |
| `apps/client/src/main.tsx` | 新增 `?obs=1` 独立路由（不连 WebSocket） |
| `apps/client/src/live/Live.tsx` | `?hud=1` 时渲染 `FirstAudioHud` 小角标；引入 `obs.css` |
| `apps/client/src/core/connection.ts` | `playback_started` 上报回调里旁路调用 `recordFirstAudioMs(clientMs)` |
| `apps/client/vite.config.ts` | dev 代理新增 `/obs` → 服务端 |

### 本会话相对上一会话的增量（补齐缺口）
1. **修类型错误**：`obsSanitize.test.ts` 里 `fc.oneof({ depthFactor, size }, …)` 在 fast-check 4.10.2 已不支持该约束 → 改为直接 `fc.oneof(fc.string(), …)`，`pnpm typecheck` 恢复全绿。
2. **补 `duration_ms` 白名单 + 汇总回落**：`sanitize.ts` 白名单加 `duration_ms`；`summarize.buildModelCalls` 的耗时 `msOf()` 优先顶层 `ms`，否则回落 `detail.duration_ms`（commandcode 的 `llm_usage` 事件已带该字段）。使 §1.4「模型调用平均耗时」对 LLM 端口有数据。
3. **新增路由测试** `obsRoute.test.ts`（缺省开启 200 + 合法 JSON；`OBS_ENABLED=0` → 404；响应不含 `sk-`/`Bearer`）。
4. **新增 e2e** `obs.spec.ts`。
5. **新增报告** 本文件。

## 2. 白名单字段清单（`sanitize` detail）
顶层始终保留：`ts / sessionId / turnId / event / ms`。
detail 白名单（其余一律丢弃，字符串截断到 40 字符）：

- 枚举 / 状态类：`code`、`status`、`port`、`provider`、`reason`、`scope`、`category`、`input`
- 数值类：`bytes`、`limit`、`used`、`chars`、`seq`、`clientMs`、`first_audio_ms`、`server_ms`、`duration_ms`、`afterBeat`、`last`、`incoming`、`cps`
- 布尔类：`silent`、`suggestAccepted`、`advanceAccepted`

被有意丢弃的字段（含文本风险）：`text`、`say`、`message`、`warnings`、`storyEventId`、`voiceKey`、`characterId`、`ids`、`apiKey`/`token` 等 Key 样式串、任意嵌套对象 / 数组。

## 3. 各阶段对应哪些事件（`summarize` 时间线）
以 `(sessionId, turnId)` 聚合，起点取该轮最早的 `turn_start`（`turnId=0` 的会话级事件不进时间线）：

| 阶段 | 事件 | 备注 |
| --- | --- | --- |
| 起点（t0） | `turn_start` | 相对基准，`rel = ts - t0` |
| STT 完成 | `stt_done` | 无则 `sttMs` 为空（文字轮） |
| LLM 首句 | `llm_first_beat` | |
| **TTS 首包** | `tts_first_audio` | **重点指标「首包延迟」** |
| 开始播放 | `playback_started` | 优先取 `detail.clientMs`（端到端），否则服务端相对时间 |
| 结束 | `turn_end`（`endMs` + `detail.reason`）/ `turn_aborted`（`aborted=true`）/ `turn_failed`（`failed=true`） | |

阶段耗时分布 `stages`：`stt` / `llm_first_beat` / `first_audio` / `playback` / `turn_total`，各给 p50 / p95 / max / 样本数（空样本不出行）。
错误与兜底 `errors`：见下。模型调用 `modelCalls`：见下。

**错误 / 兜底事件集合**（`ERROR_EVENTS`）：`turn_failed`、`fallback_used`、`media_failed`、`provider_fallback`、`quota_exceeded`、`bad_message`、`message_too_large`、`upgrade_rejected`、`handler_failed`、`ws_error`、`unknown_session`、`unknown_character`、`stale_turn`、`voice_fallback`、`tts_pace_warning`、`llm_beat_warning`；按 `event` + `code`/`category` 计数，同时给「全部」与「最近 5 分钟」。
**模型调用端口映射**：`fish_call`（按 `detail.port` = stt/tts）→ 对应端口成功；`llm_usage` → llm；`tts_synthesized` → tts；`media_scheduled` → image（成功）；`media_failed` → image（失败）；`provider_fallback`（按 `detail.port`）→ 对应端口失败。

## 4. 补了哪些 `ms`
- **本会话未新增业务埋点**（遵守 §背景「本批不新增业务埋点」）。
- 已有的 `ms`：服务端 `session.ts` 的 `turn_start / director_decision / llm_first_beat / beat_sent / tts_first_audio / tts_done / turn_end` 等事件在运行日志中已带顶层 `ms`（既有实现，非本批新增）。
- **本会话新增的读取**：`summarize` 的模型调用耗时除顶层 `ms` 外，新增回落 `detail.duration_ms`（commandcode `llm_usage` 已带此字段），并把 `duration_ms` 加入 `sanitize` 白名单。**未改任何适配器 / session 业务代码**。

## 5. 测试结果
- `pnpm typecheck`：**全绿**（protocol / yuna-assets / probes / server / client 全部 Done）。
- `pnpm test`（vitest）：**74 通过 / 1 失败文件**。obs 相关：
  - `obsSanitize.test.ts` 8 通过；`obsSummarize.test.ts` 16 通过；`obsRoute.test.ts` 3 通过。
  - 唯一失败：`apps/server/test/connection.test.ts` 5 个用例失败，报错「真实模式缺少 TTS 音色环境变量 FISH_VOICE_ID」。
- `pnpm e2e e2e/obs.spec.ts`（`E2E_SERVER_PORT=8988 E2E_CLIENT_PORT=5374`）：**4 通过**（iphone-13 + desktop 各 2 条）。截图 `e2e/out/s6h-obs.png`（1440×900，已生成；本会话未查看图片内容）。

### 关于 `connection.test.ts` 的失败（**先于本批存在，非本批引入**）
- 该测试在 `startServer` 时未传 `PROVIDER_MODE: "mock"`，落到 `loadConfig` 的 real 默认；而 vitest **不自动加载 `.env`**，故 `FISH_VOICE_ID*` 取不到 → 启动即抛错。
- 已用 `git stash` 单独还原 `apps/server/src/index.ts` 后复现同样的 5 个失败，**证明与 S6h 改动无关**。本批对 `index.ts` 只在 logger 旁路 + 路由处加接线，不触及 config / 音色加载路径。
- 该失败属既有环境/测试写法问题，**不在本批授权范围**，保留原样，记录在此待另行处理。

## 6. 端口
- e2e 使用 `E2E_SERVER_PORT=8988 E2E_CLIENT_PORT=5374`，运行前确认两端口空闲，**一次通过，未换端口**。

## 7. 可能与 S6c / S6f 冲突的文件
- `apps/server/src/index.ts`：本批只在 (a) `logger` 创建处包一层旁路、(b) `/generated/` 之前插一条 `GET /obs/summary` 路由。均为纯新增，未重排既有代码。
- `apps/client/src/main.tsx`：只在 `?docs=1` / `?preview=yuna` 之外新增 `else if (params.get("obs") === "1")` 分支。
- `apps/client/vite.config.ts`：只在 proxy 表里新增一条 `/obs`。
- `apps/client/src/core/connection.ts`：只在既有 `setPlaybackStartedReporter` 回调里加一行旁路；`apps/client/src/live/Live.tsx`：只在 HUD 里加一个 `<FirstAudioHud />` 与样式引入。
- 以上四处均位于其他批次也在改的文件，但**只加接线**，理论上可干净合并；若合并时发生上下文冲突，请以「保留双方新增行」为准。

## 8. 未决 / 不确定项
- `docs/tasks/.s6h-cmd.log`（空文件）为上一会话遗留的临时日志，未纳入本次逻辑；保留原样，可自行删除。
- 观测页文案 `OBS_TEXT` 中的 `renderStage` 未做——阶段名（`stt`/`first_audio` 等）以英文原样显示（数据字段，非 UI 文案），如需中文化可在 `obsText.ts` 增补映射。
