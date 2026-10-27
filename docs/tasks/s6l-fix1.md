# S6l-fix1 任务说明：刷新后恢复生成背景和聊天记录

> 来源：用户 2026-10-28 实测反馈「生成的背景和聊天记录一刷新就没了」。Claude 已核实原因。执行者：Command Code（deepseek-v4-flash）。在合并了 S6l 的 main 上做。
> 关卡 1–5 结论见末尾（小修，Claude 决定）。

## 铁律
冲突停下写进报告；Key 只从 `.env` 读取、不得打印；不准 commit；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片；长命令显式传大 timeout，同一命令超时两次就停下写进报告；测试里不发真实网络请求。先写会失败的测试，再改代码。不改任何台词和样式。

## 现状（已核实）
- 刷新后客户端用 `sessionStorage` 的 `mira.sessionId` 发 `hello.resumeSessionId`，服务端 `session.ts` 能找回同一个会话（`session_resumed`）。
- 但服务端回的 `session` 消息只有 `{ snapshot: session.scene }`；会话里其实还留着：生成背景 `session.sceneJob.lastReadyLabel / lastReadyUrls`（图片文件仍在 `var/generated/`）、对话 `session.history`。
- 客户端背景与弹幕列表只在内存里，所以刷新后回到默认背景、弹幕清空。

## §1 协议与服务端
- `session` 消息 payload 增加（`packages/protocol/src/messages.ts`，zod 同步）：
  - `background: { label: string; urls: <与 scene_status ready 相同的 urls 结构> } | null` —— 来自 `sceneJob.lastReadyLabel/lastReadyUrls`，没换过背景为 null。
  - `transcript: Array<{ role: "user" | "assistant"; text: string }>` —— 来自 `session.history`，最多最近 40 条；assistant 的多句按原样（换行分隔）保留。
- 新会话（非恢复）发 `background: null, transcript: []`。字段对旧客户端是新增可选，不破坏现有解析。

## §2 客户端
- 收到带 `background` 的 `session` 消息：直接切到该背景（走 scene_status ready 的同一套应用逻辑，但**不播「生成中」状态和切换动画**，直接显示）。
- 收到 `transcript`：把 `role:"user"` 的条目按顺序恢复进弹幕列表（显示为「你」发的弹幕，样式与平时一致），不重复添加；assistant 条目不进弹幕区（字幕不恢复，避免刷新后突然出现旧字幕）。
- 剧情进度（S6l 的顶栏标题与进度点）本来就由 `snapshot` 恢复，确认刷新后仍正确。

## §3 测试
- 服务端集成：换背景成功 → 同 sessionId 重新 hello → `session` 消息带 `background`（label/urls 与 ready 时一致）和 `transcript`；新会话为 null / []；transcript 超过 40 条时只保留最近 40 条。
- 客户端单测：reducer / store 收到带 background、transcript 的 session 消息后，背景 url 正确、弹幕里有用户的历史消息且不重复。
- e2e（Mock）：发一条消息 → 触发换背景并等到成功 → `page.reload()` → 断言背景仍是生成图、用户刚发的弹幕仍在、剧情进度不变。
- `pnpm test`、`pnpm typecheck` 全绿；`PROVIDER_MODE=mock pnpm smoke` 通过。

## §4 报告 `docs/tasks/s6l-fix1-report.md`

## 关卡 1–5 结论（Claude 决定）
1. **YAGNI**：只恢复背景与用户弹幕；不做持久化存储（服务端重启后会话本来就会丢，README 已列为已知限制），不恢复字幕。
2. **端口/适配器**：不碰外部服务；只扩 `session` 消息。
3. **函数式核心**：服务端从 session 取 background/transcript 写成纯函数 `resumePayload(session)`；客户端恢复逻辑走 reducer。
4. **契约式设计**：服务端是唯一事实来源；新字段可选，缺省按 null / [] 处理；transcript 上限 40。
5. **测试奖杯**：服务端集成 + reducer 单测 + 1 条刷新 e2e。
