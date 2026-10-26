# S5-1 故障注入：端口装饰器 + `?fail=`（Q11）及降级路径

你是执行工程师。不要 commit，不要改 `docs/architecture/`。只读背景：`decisions.md` 的 D9、D10、D20，`discussion.md` 第 10–11 轮的失败处理表，`quality-scenarios.md` 的 Q5–Q8、Q11。
**同时有另外两个 Agent 在工作**：`tools/live2d-pipeline/` 和 `tools/probes/` 不要碰。

## 铁律
1. 说明和验收冲突时，停下来报告，不得改变测试意图；现有 249 个测试的意图保持不变。
2. 不许改动，也不许绕过本文授权范围以外的模块。
3. 没有 `.env` 时 `pnpm dev` 必须完整可用；测试一律不得读取真实 Key（Q10）。

## 授权范围
- 新增 `apps/server/src/adapters/faults.ts` 及其测试。
- `apps/server/src/index.ts`、`session.ts`：只允许在「创建端口实例」的地方套上装饰器，并接入下面 §2 的降级逻辑。
- `packages/protocol`：只能新增，例如在 `hello` 的 payload 里加可选字段 `faults?: string[]`。
- 客户端 `connection.ts`：读取 URL 上的 `?fail=` 参数，放进 hello 消息。

## 1. 装饰器 `withFaults(port, kind, faults)`
覆盖 STT、LLM、TTS 三类端口（为 `media` 预留类型）：

| 值 | 行为 |
|---|---|
| `llm_timeout` | LLM 一直不产出内容，直到 signal 被中止 |
| `llm_error` | LLM 立即抛出非中止类错误 |
| `tts` | 每一句 TTS 都抛错 |
| `tts_once` | 只有第一句 TTS 抛错 |
| `stt` | STT 返回空字符串 |
| `slow` | 每次调用端口前额外等待 1500ms，等待期间能响应 signal |
| `ws_drop` | 本轮第 2 个 beat 发出后，服务端主动关闭连接 |

- 故障按会话生效，从 hello 中读取；环境变量 `FAULTS=` 作为全局默认值。
- 必须原样透传 AbortSignal，不能破坏现有的取消语义。

## 2. 降级路径（失败处理表）
- **LLM 首 token 超时**（默认 10s，可通过环境变量配置）：中止 LLM，下发一句兜底台词作为 beat（台词放在 Mock 剧本里，`emotion: guarded`），然后依次下发 `error{code:"llm_timeout", retryable:true}` 和 `turn_end{reason:"error"}`。
- **TTS 失败**：每一句先重试 1 次；仍然失败的，这一句不下发 `tts_audio`（作为无声 beat），并下发 `error{code:"tts_degraded", retryable:false}`。**本轮不中断**，最后正常 `turn_end{done}`。
- **STT 返回空**：下发一句「刚才没听清」的 beat（台词放进 Mock 剧本），然后 `turn_end{done}`。
- 以上每种情况都写一条结构化日志 `fallback_used`，detail 里注明类别。

## 3. 测试（每种故障至少 1 条，用假的 send 和假计时器）
`llm_timeout`、`llm_error`、`tts_once`（重试成功）、`tts`（全部无声，但本轮正常结束）、`stt`、`slow` 等待期间被打断（旧轮在中止后发出的消息数为 0）、`ws_drop`；另外，不配置任何故障时行为完全不变。

## 完成标准
`pnpm test`、`pnpm typecheck`、`pnpm smoke` 全部通过；smoke 里新增一段用 `faults:["tts"]` 跑完的一轮。写 `docs/tasks/s5-faults-report.md`。
