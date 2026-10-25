# G1-b 任务说明：导演层 + 三份契约 + 属性测试

你是执行工程师。不要 commit，不要改 `docs/architecture/`。
只读背景：`docs/architecture/decisions.md` 中的 **D28（视觉映射表）、D29（导演层与契约）**、D27、D30；`docs/architecture/quality-scenarios.md`；`docs/tasks/g1-a-report.md`。

## 铁律
1. 说明和验收测试冲突时停下来报告，不得为了通过测试而修改测试意图。
2. 不许改，也不许绕过。没有授权的模块，既不能改，也不能想办法绕开。
3. `pnpm dev` 在没有 `.env` 的情况下必须完整可用（Q10）。

## 授权范围
- 新增 `apps/server/src/director/`；修改 `apps/server/src/ports.ts`（LLM 端口的输出类型）、`session.ts`（接入导演层）、`adapters/mock/mockLlm.ts`（改为输出 LlmBeat）。
- `packages/protocol`：只允许**新增**导出（例如素材清单类型），不得修改已有 schema。
- 新增 `apps/client/src/render/manifest.ts`（素材清单，只是数据，不包含渲染代码）。
- 新增开发依赖：`fast-check`（只装到 server 和 client 的 devDependencies）。
- 测试：mockLlm 和 session 中关于 reveal 视觉字段的断言，可以**迁移**到导演层测试，但必须保持意图：「进入 reveal 的那一轮出现 photo_letters / close_up / rain_stop / show_polaroid / polaroid」，这条行为验收不能丢。

## 1. LLM 端口改为输出 LlmBeat（契约 ①）
- `LLMPort.streamBeats` 产出 `unknown`，会话层先用 `parseLlmBeatLenient` 解析成 `LlmBeat`（字段为 say / emotion / suggest / advance），**再交给导演层处理**。
- MockLLM 改为只输出 LlmBeat：去掉 hands / camera / fx / media；原来的视觉意图改用 `suggest` 和 `advance` 表达（例如 reveal 那一轮输出 `advance:"reveal"` 和 `suggest:"show_polaroid"`）。剧情推进规则不变。
- 顺手修一句台词：「那杯咖啡凉了。算了，我再给你点一杯。」不符合设定。那杯咖啡是凛给她等的人点的，不是给用户的。改成一句暗示「它一直没人动」的台词。

## 2. 导演层 `apps/server/src/director/`
### 2.1 `vocab.ts`
- 情绪对应 Fish 标签（只用于生成 TTS 文本，不发给客户端）：neutral → 无标签，calm → `[calm]`，guarded → `[soft tone]`，sad → `[sad]`，warm → `[gentle]`，surprised → `[surprised]`。集中放一张表，后续由 P3 实测调整。
- 动作对应的手部状态：sip_coffee → cup，show_polaroid → polaroid，check_phone → phone，glance_window → 保持当前手部状态。

### 2.2 `director.ts`：纯函数 `direct(llmBeat, ctx) → { beats: DirectedBeat[], ctx: 更新后的 ctx }`
- `DirectedBeat = { beat: Beat（seq 由会话层分配，这里先填 0）, ttsText: string }`。ttsText = Fish 标签 + 台词；台词为空时 ttsText 也为空。
- `ctx` 包含：scene（SceneState）、recentActions（最近 3 个 beat 用过的动作）、本轮是否已经推进过剧情、本轮已产出的 beat 数。
- **规则（后置条件）**：
  1. emotion 直接透传（契约 ① 已经降级处理过）。
  2. 动作：`suggest` 不在最近 3 个 beat 里出现过 → 采纳为 action，同时按 §2.1 设置 hands；否则 action=null、hands 保持不变。**每个 beat 最多一个动作。**
  3. 剧情：`advance` 交给现有的 `story.ts` 校验（每轮最多推进一步）。**只有校验通过**时，才按节点规则覆盖视觉：
     - 进入 reveal：camera=close_up，fx=rain_stop，media={type:"photo",id:"photo_letters"}，action=show_polaroid，hands=polaroid；如果 emotion 是 neutral 就改成 sad。
     - 进入 ending：camera=wide，fx=warm_glow。
     - 会话的第一个 beat：fx=rain_heavy。
  4. **camera / fx / media 只能来自规则 3**，其余情况一律为 null。
  5. **第一句限长**：本轮第一个 beat 的 say 超过 20 个字时，按「，。？！…」在 20 字以内最近的标点处切成两个 beat，视觉字段只放在第一个 beat；找不到标点就不切。
- **不变量**（每次调用后都必须成立）：剧情节点只进不退；trust 在 0–3 之间；fx=rain_stop 只在 node ≥ reveal 之后出现；同一个 beat 里 media 最多一个。

### 2.3 接入会话
- 会话层在处理每个 LLM 原始输出时，依次执行 `parseLlmBeatLenient` → `direct` → 分配 seq → 发送 beat → 用 `ttsText` 调用 TTS。warnings 和导演层的决定都写进日志（新增事件 `director_decision`，detail 中包含采纳或拒绝了哪个 suggest/advance）。
- 原有的发送守卫、TTS 排序、取消逻辑**一律不改**。

## 3. 契约 ③：素材清单 `apps/client/src/render/manifest.ts`
- 按 D28 写一份映射：每个 Emotion 对应哪些面部贴片文件（`assets/parts/*.png`），每个 Hands 对应哪张手部贴片，眨眼和口型用哪几张。
- 注意 D28：warm = mouth_smile + blush（brow_soft 已废弃）；calm 和 neutral 用 master，不叠贴片；guarded = eyelid_half。
- 新增测试：**每一个 Emotion 和 Hands 的枚举值都有映射，并且映射到的文件在 `assets/parts/` 中真实存在**。以后新增枚举值却忘了出图，这条测试会失败。

## 4. 属性测试（fast-check，框架第 5 步：对契约边界做模糊测试）
- `parseLlmBeatLenient`：任意 JSON 风格的输入（包括非对象、字段类型错误、超长字符串）都**不抛错**，并且输出总能通过 `LlmBeat` schema。
- `direct`：随机生成 50–200 个 LlmBeat 组成的序列（包括任意的 suggest 和 advance），在多轮之间连续调用，断言：**永不抛错**；§2.2 的每条后置条件和每个不变量都成立；同一个 action 在任意连续 3 个 beat 内最多出现一次。
- 每个属性跑至少 500 次。

## 5. 完成标准
- `pnpm test`、`pnpm typecheck`、`pnpm smoke` 全部通过（Q1、Q2 相关的已有测试必须保留并通过）。
- 写 `docs/tasks/g1-b-report.md`，内容包括：改动和新增的文件；**迁移了哪些断言、迁到了哪里**（逐条列出）；属性测试的数量和运行次数；你发现的歧义或矛盾。
