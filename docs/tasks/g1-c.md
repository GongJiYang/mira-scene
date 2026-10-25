# G1-c 任务说明：状态机 B（表演）与 C（剧情媒体），以及连接层补充

你是执行工程师。基线是 `8e61a7b`。不要 commit，不要改 `docs/architecture/`。
只读背景：`docs/architecture/decisions.md` 中的 **D28（三台状态机与视觉映射表）**、D27、D32、D8 复核；`quality-scenarios.md`；`docs/tasks/g1-b-report.md`。

## 铁律
1. 说明与验收测试冲突时，停下来报告，不得为了通过测试而改变测试的意图。
2. 不许改，也不许绕过。本文没有授权的模块不能改，也不能想办法绕开。状态 A 的已有转移规则和 86 个原始测试的意图一律不得改动。
3. 没有 `.env` 时，`pnpm dev` 必须能完整使用（Q10）。

## 授权范围
- 新增 `apps/client/src/state/performance.ts`（B）、`apps/client/src/state/storyMedia.ts`（C），以及它们的测试。
- `apps/client/src/core/`：新增表演时钟（驱动眨眼、待机、主动行动的定时器）、连接心跳。
- `apps/client/src/view/useStageViewModel.ts`：只允许**新增**字段，已有字段不能改。占位 UI 可以显示这些新字段。
- `apps/server/`：心跳回复、握手令牌、消息大小上限、会话限额。
- `packages/protocol`：只允许**新增**导出。

## 1. 状态机 B：表演（纯 reducer，可单测）
- 状态：`face`（当前情绪对应的贴片组合，按 `render/manifest.ts`）、`blink`（open / half / closed）、`mouth`（closed / small / open）、`hands`、`activeAction`（含开始时间）、`idleSince`。
- 输入：状态 A 的 phase 变化、开始播放的 beat、时钟 tick。
- 规则按 D28 映射表执行：
  - idle：每 2–6s 随机眨一次眼（open→half→closed→half→open，每帧约 60ms）；进入 idle 超过 8s，随机执行一个待机小动作。
  - listening：面部切换为「看镜头」，嘴闭合。
  - thinking：使用 eyelid_half；持续超过 2s 时补一次 sip_coffee。
  - speaking：表情跟随 beat 的 emotion；嘴在 closed / small / open 之间循环（每 90–140ms 切换一次）；手部跟随 beat 的 hands 或 action。
  - error：使用 brow_raised。
- **打断**：A 进入 listening 时，面部**立即**切换；手部 200ms 平滑收回到 cup（用 `handsTransition` 字段表达过渡进度，让 UI 可以做淡入淡出）。
- **主动行动（D32）**：A 处于 idle 且用户 12s 没有任何输入时，产出一个 `nudge` 事件，交给 controller。本批 controller 只把它记进日志和视图模型（`pendingNudge`），**暂不发送到服务端**，S3 再接。
- 随机数通过注入的函数取得，测试中用固定种子。

## 2. 状态机 C：剧情媒体（D27）
- 状态：`none → developing → ready → shown`，失败时转为 `fallback`，`fallback` 之后也进入 `shown`。按 `storyEventId` 去重。
- `media_ready` 消息**不经过 turnId 过滤**，直接送进 C。
- ready → shown 的条件：A 不处于 speaking 或 listening。否则排队，等下一次 idle 再显示。
- 显影中开始新的一轮时，**不作废**。
- 测试覆盖两种到达顺序：ready 先于 speaking 结束、ready 晚于 speaking 结束；ready 时 A 处于 listening；显影中被打断。
- 本批服务端**还不会**发 `media_ready`（S4 才做），测试中直接构造消息。

## 3. 连接层补充（D8 复核 · Q12）
- **心跳**：客户端每 15s 发一次 `ping`，服务端回 `pong`；30s 收不到 `pong` 就判定断线，按现有逻辑退避重连，退避时间加 ±20% 随机抖动。
- **握手令牌**：服务端新增 `GET /session-token`，返回一个随机令牌，内存保存，30 分钟过期。WS 升级时必须带 `?token=`，缺失或无效就拒绝升级（返回 401）。客户端在连接前先请求令牌。
- **消息上限**：单条消息超过 2MB 时，服务端关闭连接（关闭码 1009），并写日志。
- **会话限额**：每个会话最多 30 轮，全站每天最多 300 轮（内存计数，按自然日重置；用环境变量 `SESSION_TURN_LIMIT`、`DAILY_TURN_LIMIT` 覆盖）。超出时返回 `error{code:"quota_exceeded", retryable:false}`，并且**不调用任何 Provider**。
- smoke 脚本要同步更新：先取令牌再连接。

## 4. 完成标准
- `pnpm test`、`pnpm typecheck`、`pnpm smoke` 全部通过，原有的 188 个测试意图保持不变。
- 新增测试至少覆盖：B 的每条 phase 规则、打断时的面部立即切换和手部过渡、12s 主动行动、C 的四种异步到达顺序、心跳超时判断、令牌缺失被拒、2MB 上限、两种限额。
- 写 `docs/tasks/g1-c-report.md`：列出改动的文件、新增的测试，以及你发现的歧义或矛盾。
