# S6n 报告：设置面板——切换 Mock / 真实 + 浏览器自带 Key（D49）

> 执行者：Command Code。基线：合并 S6m 的 `main`（分支 `s6n`）。铁律：Key 安全优先；未 commit；未运行 e2e；未打开任何图片。

## 结果概览

- `pnpm typecheck`：全绿（protocol / server / client / probes / yuna-assets）。
- `pnpm test`：**964 passed / 97 files**（含新增 S6n 单测 38 项 + 脱敏属性测试）。
- `PROVIDER_MODE=mock pnpm smoke`：**SMOKE OK**。
- e2e `e2e/s6n.spec.ts`：**只写不跑**（按铁律）。

上一会话中断遗留的改动已保留，本次只**补完剩余内容**并修正阻断性缺陷（见「本次修复」）。

## 本次修复（上一会话未完成 / 有缺陷的部分）

1. **阻断性编译错误**：`apps/server/src/index.ts` 引用了未定义的 `EMPTY_CREDENTIALS`；且两处 `buildProviders(...)` 调用缺必填的 `serverCredentials`。→ 补上 `EMPTY_CREDENTIALS` 常量（mock 判定用的空凭据），两处调用补传 `serverCredentials`。
2. **未用导入**：`s6nIntegration.test.ts` 里 `SceneWriterPort` / `buildProviders` 已导入未用（`noUnusedLocals` 报错）。→ 删除。
3. **§4 脱敏缺口（Key 安全，最高优先）**：`session.ts` 的 `turn_failed` 路径此前把原始错误 `message` 直接写入日志并下发（若适配器回显了请求头 / URL 参数则会泄漏 Key）。`index.ts` 的 `handler_failed`、`session.ts` 的 `media_failed` 同样。→ 在 `obs/sanitize.ts` 新增纯函数 `redactSecrets(text)`（替换 `Bearer <token>`、`key=/apiKey=/token=/authorization=` 键值对、裸 `sk-...` 字面量），并在上述三处写日志 / 下发前统一过滤。
4. **§4 集成测试过弱**：原「特征串假 Key」测试的假 TTS 实际返回成功、根本没走错误路径，断言形同虚设。→ 改为投喂「错误信息里带 Key」的假 LLM（触发 `turn_failed`），断言 `turn_failed` 的 message 含 `[redacted]`、不含特征串，且日志 / 观测缓冲 / 下行消息全不含特征串。
5. **§3 客户端提示**：`voice_unavailable` 此前未在客户端体现。→ 在 `SETTINGS_TEXT` 增加 `voiceUnavailable` 文案，并在 `connection.ts` 收到该错误时提示「这个 Fish Key 用不了忧奈的音色，可以在设置里填自己的音色 ID」。
6. **§7 文档**：`docs/deploy.md` 环境变量表后补一句 BYOK 说明。

## 改动文件

**协议（packages/protocol）**
- `src/messages.ts`：`helloPayloadSchema` 增 `mode?: "mock"|"real"|"auto"`、`keys?`（`helloKeysSchema`：deepseek / fish(+voiceId) / image(+baseUrl,+model)）；`sessionPayloadSchema` 增 `mode`、`capabilities`（`sessionCapabilitiesSchema`：llm/voice/image 各为 `"user"|"server"|"none"`）。新增导出类型 `HelloKeys` / `CapabilitySource` / `SessionCapabilities`。

**服务端（apps/server）**
- `src/providers.ts`（新增）：工厂 + 纯函数核心。`chooseKey` / `resolveKeys`（访问者优先，否则服务端）、`missingForReal`、`resolveMode`（auto/mock/real 规则）、`computeCapabilities`、`planSession`、`buildProviders({mode, keys, serverCredentials, serverConfig, logger, env})`。
- `src/config.ts`：新增 `readServerCredentials(env)`——不论 `PROVIDER_MODE` 都读取 `.env` 凭据（供 real 可用性判定；只读入内存，不打印）。
- `src/index.ts`：删除就地拼装适配器的逻辑，改调工厂；启动时预建 Mock（全局共享）+ 判定「服务端真实是否可用」；`createSessionManager` 注入 `planSession` / `mockProviders` / `buildProviders`。新增 `EMPTY_CREDENTIALS`。
- `src/session.ts`：`handleHello` 解析 `mode`/`keys` → `planSession`；显式 real 缺 Key → `error{real_unavailable, scope:session, retryable:false}` 且不建会话；会话持有 `mode`/`capabilities`/`voiceIdUser`/`media`；`session` 下行带 `mode` + `capabilities`；恢复会话沿用原模式与 Key（不重读 hello）；TTS 遇 `fish_voice` → `error{voice_unavailable, scope:session}`，停止重试与后续 TTS（不省略 `reference_id`、不静默降级）；`hello_provision` 日志只记 `{mode, byok:{llm,voice,image}}`（布尔）；`turn_failed`/`media_failed` 经 `redactSecrets`。
- `src/obs/sanitize.ts`：新增 `SECRET_FIELD_PATTERN`（形如 Key 的字段名 → 值 `[redacted]`）与 `redactSecrets(text)`。
- `src/adapters/fish/errors.ts`：新增错误码 `fish_voice`（4xx 非 402/429）。

**客户端（apps/client）**
- `src/live/settings.ts`（新增）：`Settings`、`DEFAULT_SETTINGS`、`SETTINGS_TEXT`、`resolveRequestedMode`、`helloKeysFrom`（空串不发送）、`capabilityLabel`、`loadSettings`/`saveSettings`（try/catch）、`clearStoredKeys`、zustand store（`mira.settings`）。
- `src/live/SettingsPanel.tsx`（新增）：桌面对话框 / 手机底部抽屉共用主体；模式三选一；三组 Key（`type=password` + 显示切换）+ 来源标签；保存并重连 / 清除我的 Key；顶栏 `ModeBadge`。
- `src/live/entries.tsx`、`src/live/Live.tsx`、`src/live/live.css`：接入设置入口与顶栏模式标签、样式。
- `src/core/connection.ts`：hello 带 `mode`/`keys`；`real_unavailable` → 提示 + 自动回落 mock 一次并重开会话；`session` 下 `mode`/`capabilities` 落 store；`voice_unavailable` → 提示。
- `src/core/controller.ts`：intents `saveSettings` / `clearKeys` / `applyMode`（切模式 = 新会话）。
- `src/view/useStageViewModel.ts`：暴露 `settings` / `sessionMode` / `capabilities`。

**测试与文档**
- `apps/server/test/providers.test.ts`（新增，18 项）、`apps/server/test/s6nIntegration.test.ts`（新增，10 项）、`apps/client/test/settings.test.ts`（新增，10 项）、`apps/server/test/obsSanitize.test.ts`（改：Key 字段名脱敏 + `redactSecrets`）。
- `e2e/s6n.spec.ts`（新增，只写不跑）。
- `docs/deploy.md`（§7 一句）。

## 规则 → 测试名对照

| 规则 | 测试 |
|---|---|
| §1 访问者 Key 优先，否则服务端 | `providers.test.ts` › `chooseKey：访问者优先，否则服务端`（4）、`resolveKeys：三类 Key + 音色覆盖`（3） |
| §2 auto：LLM+语音都有 Key → real | `resolveMode：规则矩阵` › `auto：LLM 与语音都有 Key → real` |
| §2 auto：缺任一类 → mock | `resolveMode：规则矩阵` › `auto：缺任一类 → mock`、`auto 模式下访问者补齐服务端缺的那一类 → real` |
| §2 real 缺 Key → 报错点名缺哪类 | `resolveMode：规则矩阵` › `real：有 Key → real；缺 Key → real + missing`、`planSession` › `显式 real 但缺两类 → ok:false 且 missing 点名` |
| §2 real 缺 Key → 服务端回 real_unavailable、不建会话 | `s6nIntegration.test.ts` › `显式 real 但缺 Key → error{real_unavailable}，不建会话` |
| §2 capabilities 只说明来源、不含 Key | `computeCapabilities：只说明来源，不含 Key`（2） |
| §1 BYOK 会话用访问者 Key 构建适配器 | `s6nIntegration.test.ts` › `auto + 访问者两类 Key → real，工厂收到访问者的 Key` |
| §2 两个会话一 mock 一 real 互不影响 | `s6nIntegration.test.ts` › `一个 mock 一个 real，各自绑定自己的模式与 capabilities` |
| §2 恢复会话沿用原模式 / Key、不重读 hello | `s6nIntegration.test.ts` › `resumeSessionId 恢复用原模式，不重读 hello 里的 mode / keys` |
| §3 voice_unavailable 不重试、不省略 reference_id | `s6nIntegration.test.ts` › `Fish 4xx 音色错误 → 会话级 error{voice_unavailable}，且 TTS 只被调用一次` |
| §3 音色覆盖透传 | `s6nIntegration.test.ts` › `访问者填 voiceId → 会话的 TTS 收到该音色` |
| §4 特征串假 Key 走完一轮不外泄 | `s6nIntegration.test.ts` › `BYOK 会话一轮后，日志 / 观测缓冲 / 下行消息都不含特征串` |
| §4 hello 日志只记 mode + byok 布尔 | `s6nIntegration.test.ts` › `hello 的日志只记 mode 与 byok 布尔，不含任何 Key` |
| §4 Key 字段名值脱敏（含 authorization） | `obsSanitize.test.ts` › `Key 样式字段名 … 替换为 [redacted]`、`redactSecrets（S6n §4…）`（4） |
| §4 属性：sanitize 输出只含白名单 / Key 名 | `obsSanitize.test.ts` › `属性：任意 detail 进去，输出只含白名单 / Key 名，且字符串值 ≤ 40` |
| §5 helloKeysFrom 空串不发送 | `settings.test.ts` › `helloKeysFrom：空字符串不发送`（6） |
| §5 模式三选一 / 合法化 | `settings.test.ts` › `resolveRequestedMode / normalizeMode`（2） |
| §5 来源 → 中文标签 | `settings.test.ts` › `capabilityLabel` |
| §5 e2e（只写不跑） | `e2e/s6n.spec.ts` › `打开设置 → 切 Mock → 保存 → 顶栏标签变 Mock` |

## 脱敏检查结果

- **字段名规则**：`sanitize` 对 `apiKey|api_key|api-key|authorization|key|token|secret`（大小写不敏感）的值一律替换为 `[redacted]`，即使该字段在白名单里也先脱敏。
- **字符串规则**：`redactSecrets` 覆盖 `Bearer <token>`、`(apiKey|api_key|authorization|token|secret|key)\s*[=:]<值>`、裸 `sk-…` 字面量。
- **写入点**：`session.ts` 的 `turn_failed` / `media_failed`、`index.ts` 的 `handler_failed` 在写日志 / 下发前统一过 `redactSecrets`。
- **日志内容**：`hello_provision` 只记 `{mode, byok:{llm,voice,image}}`（布尔）；`providers_ready` 只记 `{providerMode, serverReal}`（布尔）。
- **端到端断言**：特征串 `sk-TESTKEY-xxxxxxxx` 作为假 Key 走完一轮 BYOK 会话（假 LLM 在错误信息里回显 Key），断言原始日志、观测缓冲、下行消息 JSON 全不含该串；`turn_failed.message` 含 `[redacted]`。
- **Key 只在会话内存 / 请求头**：适配器仅在 `authorization` 头使用 Key，从不入日志、不入文件、不回传客户端（`capabilities` 仅来源枚举）。

## 未决歧义 / 备注

1. **§3 的 STT 侧 4xx**：`fish_voice` 目前只在 TTS 路径映射为 `voice_unavailable`。STT（`/asr`）无 `reference_id`，其 4xx 仍走原 `turn_failed` / 降级路径（`degrade.ts` 只吞 402/429）。任务说明 §3 全文围绕「音色 / 权限」且给的是音色相关提示，判为 TTS 语义；如需 STT 的鉴权失败也提示 `voice_unavailable`，请确认后我再补。
2. **文案位置**：§5 说「一行说明」「real_unavailable 提示」放 `uiText.ts`；实现将其集中在 `settings.ts` 的 `SETTINGS_TEXT`（同为铁律 6 的集中文案，且更贴近设置域）。功能等价，未搬动以免大范围改动；若坚持放 `uiText.ts` 可再迁。
3. **服务端 `.env` 的探测**：`readServerCredentials` 始终读 `.env` 凭据。mock 模式下服务端不提供真实能力（`serverRealAvailable` 为 false），故不与「mock 不读 Key」冲突；`.env` 无 Key 时仅返回空串，不打印。
4. **`.s6n-cmd*.log`**：上一会话残留的未跟踪日志（`docs/tasks/.s6n-cmd.log`、`.s6n-cmd-2.log`），未纳入改动、未删除。
5. **图片 / e2e**：按铁律未打开任何图片、未运行 e2e；`e2e/s6n.spec.ts` 只写。
