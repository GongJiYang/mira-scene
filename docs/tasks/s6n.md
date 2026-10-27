# S6n 任务说明：设置面板——切换 Mock / 真实模式 + 浏览器自带 Key（D49）

> 来源：D49（用户 2026-10-28 决定：浏览器自带 Key、每个会话自己选模式）。关卡 1–5 由 Claude 决定（用户授权）。执行者：Command Code（deepseek-v4-flash）。在合并了 S6m 的 main 上做。

## 铁律（本批最重要的是 Key 安全）
冲突停下写进报告；不准 commit；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片；长命令显式传大 timeout，同一命令超时两次就停下写进报告；测试里不发真实网络请求；**不要运行 e2e**（可写不跑）。样式只求清楚可用（S6u 统一重做）。
**Key 规则（D49）**：服务端自己的 Key 只从 `.env` 读取；访问者填的 Key 只在其会话内存中使用；**任何 Key 都不得打印、写进日志（含观测缓冲、调试事件、错误信息）、文件，也不得回传客户端**；日志里只能记「是否提供」（布尔）。

## 现状（Claude 已核实）
- `apps/server/src/index.ts` 启动时按 `config.providerMode`（`PROVIDER_MODE`）全局组装一次 STT / LLM / TTS / 场景扩写 / 生图，所有会话共用。
- `hello` 载荷（`packages/protocol/src/messages.ts` 的 `helloPayloadSchema`）有 `resumeSessionId`、`characterId`、`faults`。

## §1 Provider 工厂（服务端）
- 把 index.ts 里的组装逻辑抽成 `apps/server/src/providers.ts`：`buildProviders({ mode, keys, serverConfig, logger }) → Ports + sceneWriter + sceneImageGen`。`keys` 每一类可来自访问者或服务端 `.env`：**访问者提供的优先，否则用服务端的**。
- 启动时预建一套 Mock（无状态，全局共享）；服务端 `.env` 有 Key 时预建一套「服务端真实」。访问者自带 Key 的会话在 hello 时**为该会话单独构建**真实适配器，会话结束随会话释放。
- LLM 只走 DeepSeek（`LLM_PROVIDER=commandcode` 仅服务端本地开发可用，BYOK 不支持 commandcode）。

## §2 协议
- `hello` 增加：
  - `mode?: "mock" | "real" | "auto"`（缺省 auto）；
  - `keys?: { deepseek?: { apiKey } ; fish?: { apiKey; voiceId? } ; image?: { apiKey; baseUrl; model? } }`（每项可选）。
- `session` 下行增加：`mode: "mock" | "real"`（实际生效的模式）、`capabilities: { llm: "user" | "server" | "none"; voice: …; image: … }`（只说明来源，不含任何 Key）。
- 规则：`auto` → LLM 与语音都有可用 Key（访问者或服务端）则 real，否则 mock；`real` 但 LLM 或语音缺 Key → 回 `error{ code: "real_unavailable", scope: "session", retryable: false }` 并说明缺哪一类，客户端提示后自动回落 mock 重新建会话（提示文字「真实模式缺少聊天 / 语音的 Key，已切回 Mock」放 `uiText.ts`）。生图缺 Key 不阻止 real（换背景走 Mock 测试图，与现状一致）。
- 恢复会话（`resumeSessionId`）时沿用该会话原来的模式与 Key，不重新读 hello 里的 keys。
- **切换模式 = 新会话**：客户端清掉 `mira.sessionId` 后重新 hello。

## §3 语音音色安全（D49 注意项）
- 访问者自带 Fish Key 时，音色仍用角色包的音色 ID（服务端 `FISH_VOICE_ID_<ID>`，它不是秘密），访问者可在面板里填 `voiceId` 覆盖。
- Fish 返回 4xx 且与音色 / 权限相关时：回 `error{ code: "voice_unavailable", scope: "session" }`，客户端提示「这个 Fish Key 用不了忧奈的音色，可以在设置里填自己的音色 ID」；**不得**省略 `reference_id` 重试（不得静默回落默认音色）。

## §4 日志与观测脱敏
- hello 的日志 / 调试事件只记 `{ mode, byok: { llm: bool, voice: bool, image: bool } }`。
- 适配器报错信息里如果可能带请求头或 URL 参数，写日志前统一经 `obs/sanitize.ts`（已有）过滤；新增规则：任何形如 Key 的字段名（`apiKey`、`authorization`、`key`）的值替换为 `[redacted]`。
- **测试**：用一个特征字符串作为假 Key（如 `sk-TESTKEY-xxxxxxxx`）走完一轮 BYOK 会话（假适配器），断言所有日志行、观测缓冲、下行消息里都不含该字符串。

## §5 客户端设置面板
- 入口：桌面顶栏一个「设置」按钮；手机放进右上角菜单。打开为对话框（桌面）/ 底部抽屉（手机）。
- 内容：
  - 模式：`自动 / Mock / 真实` 三选一；当前实际模式在顶栏显示一个小标签（`Mock` / `真实`）。
  - 三组 Key：聊天（DeepSeek API Key）、语音（Fish API Key、可选音色 ID）、生图（API Key、Base URL、可选模型）。每组旁显示来源：「服务器已配置」/「使用你填的」/「未配置」（来自 `session.capabilities`）。输入框 `type="password"`，带「显示」切换。
  - 「保存并重新连接」（保存后新建会话）、「清除我的 Key」。
  - 一行说明：「Key 只保存在这台设备的浏览器里，每次连接时发给服务器使用，服务器不保存。」（放 `uiText.ts`）
- 存储：`localStorage`（键 `mira.settings`），读写都 try/catch；读不到就当未填写。
- 纯函数：`resolveRequestedMode(settings)`、`helloKeysFrom(settings)`（空字符串不发送）、`capabilityLabel(source)`。

## §6 测试
- 单测：模式判定规则矩阵（auto/mock/real × 各类 Key 有无 × 访问者/服务端来源）；`helloKeysFrom`；capabilities 计算；`voice_unavailable` 不重试、不省略 reference_id。
- 集成：BYOK 会话使用访问者 Key 构建的适配器（假工厂断言收到的 Key）；两个会话一个 mock 一个 real 互不影响；恢复会话沿用原模式；§4 脱敏测试。
- e2e：写「打开设置 → 切 Mock → 顶栏标签变 Mock」，**不运行**。
- `pnpm test`、`pnpm typecheck` 全绿；`PROVIDER_MODE=mock pnpm smoke` 通过。

## §7 文档
- `docs/deploy.md` 的环境变量表补一句：「访问者也可在页面设置里填自己的 Key（只在其会话内存中使用）；服务器不配真实 Key 时，默认 Mock。」
- 报告 `docs/tasks/s6n-report.md`：改动文件、规则 → 测试名、脱敏检查结果、未决歧义。

## 关卡 1–5 结论（Claude 决定）
1. **YAGNI**：只支持 DeepSeek / Fish / 一个 OpenAI 兼容生图端点；不做多账号、不做服务端保存、不做 Key 校验按钮（第一次调用失败即报错）。
2. **端口/适配器**：模式与 Key 只影响「组装哪个适配器」，会话和导演层不感知；Mock 模式完整可用。
3. **函数式核心**：模式判定、capabilities、hello keys 组装、脱敏规则都是纯函数；工厂是外壳。
4. **契约式设计**：Key 不出会话内存；real 缺关键 Key 明确报错并回落 Mock；音色不可用明确报错、不静默降级；恢复会话不换模式。
5. **测试奖杯**：规则矩阵单测 + BYOK / 脱敏集成测试（假适配器，零真实网络）；e2e 只写不跑。
