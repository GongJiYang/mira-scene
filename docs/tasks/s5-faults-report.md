# S5-1 故障注入 · 完成报告

日期：2026-10-26
范围：`?fail=` 故障注入装饰器、失败处理表里的三条降级路径、冒烟覆盖。
未 commit；未启动常驻进程；未触碰 `tools/live2d-pipeline/`、`tools/probes/`、`docs/architecture/`。

## 1. 变更清单

| 文件 | 类型 | 内容 |
|---|---|---|
| `apps/server/src/adapters/faults.ts` | 新增 | `withFaults` 装饰器、`parseFaults`、`readFirstTokenTimeoutMs`、故障常量与兜底台词 |
| `apps/server/test/faults.test.ts` | 新增 | 20 条：装饰器单测 + 每种故障的会话级降级测试（假 send、假计时器） |
| `apps/server/src/session.ts` | 修改 | 每会话端口、首 token 超时兜底、TTS 重试/降级、STT 空结果、`ws_drop` |
| `apps/server/src/index.ts` | 修改 | 按 hello 的 faults 创建端口实例并套装饰器；读 `FAULTS` / 首 token 超时；`ws_drop` 关闭连接 |
| `packages/protocol/src/messages.ts` | 只新增 | `hello.payload.faults?: string[]` |
| `apps/client/src/core/connection.ts` | 修改 | 读取 URL `?fail=` 并放进 hello |
| `apps/server/scripts/smoke.ts` | 修改 | 抽出消息挂载函数；新增 `faults:["tts"]` 一轮 |

## 2. 实现要点

### 2.1 装饰器（`faults.ts`）

```ts
withFaults(port, kind, faults) // kind: "stt" | "llm" | "tts" | "media"
```

| 值 | 实现 |
|---|---|
| `llm_timeout` | 异步生成器一直挂起，signal 中止时以 `AbortError` 结束 |
| `llm_error` | 首次 `next()` 即抛 `Error("fault:llm_error")` |
| `tts` | 每次 `synthesize` 抛错（在调用原端口之前） |
| `tts_once` | 仅第 1 次调用抛错，重试的第 2 次放行 |
| `stt` | 返回 `""`，不调用原端口 |
| `slow` | 每次端口调用前 `sleep(1500, signal)`，可被中止打断 |
| `ws_drop` | 不在端口层：会话层数 beat，第 2 个后调用传输层关闭 |

- 所有包装方法先 `throwIfAborted(signal)`，并把同一个 `AbortSignal` 原样传给原端口（有单测断言引用相等）。
- 故障来源：`hello.payload.faults` 优先，缺省取 `FAULTS=`（`parseFaults`，忽略未知值、去重）。
- 每会话一份端口：`SessionDeps.createPorts(faults)` 在 hello 时创建；`index.ts` 在「创建端口实例」处套装饰器。无故障时直接复用原实例，保持既有行为。
- `media` 为预留 kind，当前原样返回端口（无媒体端口实现）。

### 2.2 降级路径（`session.ts`）

| 情况 | 行为 | 结构化日志 |
|---|---|---|
| LLM 首 token 超时 | 独立 `AbortController` 中止 LLM（不污染 turn signal）→ 兜底 beat（`emotion: guarded`）→ `error{llm_timeout, retryable:true}` → `turn_end{error}` | `fallback_used {category:"llm_timeout"}` |
| TTS 失败 | 每句重试 1 次；仍失败则该句不发 `tts_audio`，发 `error{tts_degraded, retryable:false}`，本轮继续，最后 `turn_end{done}` | `fallback_used {category:"tts"}`（每轮一次） |
| STT 空结果 | 不下发 transcript、不跑 LLM；发「没听清」beat → `turn_end{done}` | `fallback_used {category:"stt"}` |
| `ws_drop` | 本轮第 2 个 beat 发出后调用 `dropConnection(sessionId)`，服务端以 1011 关闭连接，本轮不再产出 | `ws_drop {afterBeat:2}` |

- 首 token 超时默认 10s，环境变量 `LLM_FIRST_TOKEN_TIMEOUT_MS`（非法值直接抛错，与 `config.ts` 风格一致）。
- 用户打断（signal 中止）优先于超时兜底：不会发送任何兜底消息。

## 3. 验收验证

| 命令 | 结果 |
|---|---|
| `pnpm test` | 23 个文件 / **269 条通过**（原 249 条意图不变 + 新增 20 条） |
| `pnpm typecheck` | 4 个工程（protocol / server / client / tools/probes）全部通过 |
| `pnpm smoke` | `SMOKE OK`，新增步骤 `faults:["tts"] → turn_end(done)`（608ms） |

### 额外端到端核对（一次性脚本，已删除）

| 场景 | 观察结果 |
|---|---|
| `faults:["ws_drop"]` 真实 WS | 收到 2 个 beat 后连接以 **1011** 关闭，无 `turn_end` |
| `LLM_FIRST_TOKEN_TIMEOUT_MS=500` + `faults:["llm_timeout"]` | 503ms 内 `beat(guarded) → error{llm_timeout} → turn_end{error}`，`fallback_used` 已记录 |
| `FAULTS=tts` 启动 + hello 不带 faults | 0 条 `tts_audio`、2 条 `tts_degraded`（两句）、`turn_end{done}` |
| 客户端 `readUrlFaults` | `?fail=tts` / `?fail=tts,slow` / 带空格 URL 编码均正确；空值与无参数返回 `undefined` |
| 无 `.env` | smoke 与上述脚本均未读取任何 Key（Q10） |

## 4. 偏差与限制（需主审确认）

1. **兜底台词的存放位置**：任务 §2 要求「台词放在 Mock 剧本里」，但授权范围未包含 `apps/server/src/adapters/mock/mockLlm.ts`。为遵守铁律 2（不得改动授权范围以外的模块），兜底台词以 `FALLBACK_LINES` 定义在新增的 `faults.ts` 中，内容与 Mock 剧本同源。若必须放进 `mockLlm.ts`，需要补充授权。
2. **`tts_degraded` 的条数**：按任务原文「每一句…并下发 error」实现为**每个失败句一条**；`fallback_used` 每轮一条。D20 描述为「一条提示」；若 UI 只应看到一条提示，改为每轮一条 error 即可（一行改动）。
3. **首 token 超时环境变量**未写入 `.env.example`（该文件不在授权范围）。变量名：`LLM_FIRST_TOKEN_TIMEOUT_MS`。
4. **`ws_drop` 关闭码**取 `1011`（服务端内部错误），reason `fault:ws_drop`；任务未指定关闭码。
5. 新增的 `SessionDeps` 可选字段（`createPorts` / `defaultFaults` / `firstTokenTimeoutMs` / `dropConnection`）位于 `session.ts`，用于把 hello 的按会话故障接入端口创建与 §2 降级；既有调用方不传这些字段时行为不变。

## 5. 测试覆盖对照（§3）

| 要求 | 测试 |
|---|---|
| `llm_timeout` | 装饰器挂起/中止 + 会话兜底序列（含日志） |
| `llm_error` | 装饰器立即抛错 + 会话 `turn_failed` 路径 |
| `tts_once`（重试成功） | 两个 `tts_audio` 均在、无 error、base 调用 2 次 |
| `tts`（全部无声、本轮正常结束） | 4 次尝试不触达原端口、2 条 `tts_degraded`、`turn_end{done}` |
| `stt` | 「没听清」beat、不调用 LLM、`turn_end{done}` |
| `slow` 等待期间被打断 | 中止后旧轮消息数 = 0，原端口未被调用 |
| `ws_drop` | 2 个 beat 后调用关闭回调、无 `turn_end` |
| 不配置故障 | Mock 端口完整一轮：3 beat、2 tts_audio、snapshot、done，无降级日志 |
| `FAULTS` 默认值 / hello 覆盖 | `defaultFaults` 生效；hello 的空数组覆盖默认值 |

## 6. 未做与风险

- 未 commit；未修改 `docs/architecture/`、`tools/`、`.env.example`。
- **客户端对 `error{tts_degraded}` 的展示未调整**（reducer 不在授权范围）。现状：`apps/client/src/state/reducer.ts` 的 `error` 分支会把 phase 置为 `error` 并中止当前音频，因此降级轮在 UI 上会表现为一次错误态，而不是 D20 要求的「轻提示」。服务端本轮仍按 §2 正常收尾（smoke 已验证 `turn_end{done}`）。建议后续给 reducer 区分「非终止错误码」，或给 `tts_degraded` 单独的提示消息类型。
- 无声 beat 的播放提示（字幕/动作照常）由既有调度器处理；本次未改动客户端播放链路。
