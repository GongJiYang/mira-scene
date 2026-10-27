# S6l 任务说明：剧情可感知 + 轻互动（D48 第 2 项）

> 来源：D48（用户 2026-10-28 批准）+ 关卡 1–5 结论（用户已批准）。执行者：Command Code（deepseek-v4-flash）。在 main（含 S6c-fix1、S6k）上做。
> 背景：真实模式下剧情卡在 arrive，开放式对话里用户不知道剧情在哪、该聊什么，人物也没有可点的互动。

## 铁律
冲突停下写进报告；本文给出的台词、弹幕、标题**逐字使用**，不要改写、不要自己新写；Key 只从 `.env` 读取、不得打印；不准 commit；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片；长命令显式传大 timeout，同一命令超时两次就停下写进报告；**测试里不发真实网络请求**（§7 录音脚本除外，它不是测试）。先写会失败的测试，再改代码。样式只求清楚可用，视觉重设计留给 S6u，不要花时间做美术。

## §1 修 arrive 卡死（最高优先）
- 现状：`apps/server/src/prompts/advanceRule.ts` 在 arrive / probe 都只会写「允许进入 reveal」；`story.ts` 只放行 arrive→probe，所以真实模式永远出不了 arrive。Mock 有 `mockLlm.ts` 单独推进，e2e 没暴露。
- 修法：arrive 阶段——用户说过至少 1 轮后（与 Mock 的 `priorUserTurns >= 1` 一致）写「允许进入 probe」；probe 阶段沿用现有 reveal 条件（trust≥2 / ask_core / 满 8 轮）。`ADVANCE_ALLOW_*` 文本按节点生成，不要再出现「允许进入」与 `NEXT_NODE` 不一致的情况。
- **新增集成测试**（关键）：一个「照提示词办事」的假 LLM——读渲染后提示词里的 advance_rule，若写着「允许进入 X」就在回复里带 `advance:"X"`——驱动真实 `session` 流程从 arrive 走到 ending，断言四个节点依次出现。再加一条属性测试：任意节点下 advanceRule 允许的目标必须等于 `NEXT_NODE[node]`。

## §2 剧情阶段可见
- 角色包 `content.json` 每个节点新增 `streamTitle`（pack schema 同步校验）：
  - arrive：「下播后 · 推流未关」
  - probe：「还有一位观众没走」
  - reveal：「翻到一张老截图」
  - ending：「准备关推流」
- 直播间顶部显示 `streamTitle` + 4 个进度点（当前节点高亮）。**只认服务端下发的当前节点**（现有 snapshot / beat.story），客户端不自己推断。切换时 0.3s 淡入。

## §3 观众弹幕引导
- `content.json` 每个节点新增 `guides`（字符串数组，ending 为空数组）：
  - arrive：「主播还没下播？」「今天是不是不太开心」「这么晚还不睡吗」
  - probe：「之前那张老截图还在吗」「第一次开播是啥时候来着」「后台数据很惨吗」
  - reveal：「那你还想继续播吗」「三个观众里有我吗」「要不休息一阵？」
- 显示：混在现有弹幕区，带「观众」昵称样式（昵称用现有弹幕的随机昵称机制），视觉上可点（hover/按下态 + 小提示「点一下替你说」）。
- 节奏：用户和角色都安静（idle）约 8 秒刷 1 条当前节点未用过的引导；同时最多显示 3 条；点过的不再出现；切节点后旧节点引导失效。
- 点击 = 把该文字当作用户文字输入发送（走现有发送路径，含打断逻辑）。
- 纯函数：`nextGuide(node, usedGuides, visibleGuides) → string | null`。

## §4 沉默时按阶段抛钩子
- 现有 `nudge`（全局）改为节点级：每个节点新增 `hook`（一句），沉默触发时说这句（替换原「……还在吗？弹幕好安静。」的位置；原 nudge 保留作为 ending 或无 hook 时的回退）：
  - arrive：「……其实我在想一件事。」
  - probe：「我手机里倒是存着一张老截图。」
  - reveal：「你说，我还要继续播吗。」
- 每个节点的 hook 最多触发一次。

## §5 戳一下 / 送礼物
- 协议：用户输入新增 `kind?: "text" | "poke" | "gift"`（缺省 text）。
- 服务端：poke / gift 转成给 LLM 的情景说明（放 `scene_notes`，不当作用户台词）：poke →「观众戳了你一下」，gift →「观众送了你一个礼物」；该轮第一个 beat 的 accent 由导演层规则决定：gift → love（并 fx hearts）；poke → 轮流 shy / angry。规则写在 `pickAccent` 的规则触发里（覆盖 LLM 给的 accent，仍受冲突表约束；冲突时 gift 改用 heart）。
- Mock：`content.json` 新增 `events`：
  - poke：`["干嘛戳我。", "再戳要收费了哦。"]`
  - gift：`["诶，谢谢你的礼物！", "下播了还送，你人也太好了吧。"]`
- 客户端：
  - **忧奈没在说话时**，点到忧奈本人（Live2D 非透明区域，用现有命中/包围盒即可）= 戳一下；3 秒冷却。
  - 输入栏旁加「送礼物」按钮（图标即可），10 秒冷却。
- 纯函数：`tapIntent(phase, hitCharacter) → "interrupt" | "poke" | "none"`。

## §6 点击打断
- **忧奈说话时，点画面任何位置 = 打断**（`InterruptReason` 新增 `"tap"`，走现有 `interrupt.ts` 执行器，D34 后置条件全部保持），之后进入倾听，等待用户输入。
- 与 §5 的规则合并在 `tapIntent` 里：speaking → interrupt；idle/listening 且命中角色 → poke；其他 → none。

## §7 台词与录音
- 成年设定：`prompt.v1.md` STATIC 第一句改为「你是忧奈，22 岁，大学刚毕业，做个人势虚拟主播，粉丝叫你「奈奈」。」后半句「你不是 AI……」保持不变。
- Mock 演示 dark：`content.json` arrive 节点 `ask_core` 第二句改为「下播之后脑子特别吵，估计又要熬夜了。」
- 新台词（§4 hook、§5 events、上面改的一句）需要 Mock 预录语音：给 `apps/server/scripts/record-voices.ts` 加 `--character <id>` 参数，只录 manifest 里缺失的条目（已有的不重录），然后运行一次 `pnpm voices:record -- --character yuna`（真实 Fish 调用，只在这里）。若 Fish 报余额/网络错误，停下写进报告，不要改代码绕过。
- 输入框占位文字改为「发条弹幕，或按住麦克风说话」。

## §8 测试
- 单测：advanceRule 各节点；`nextGuide`；hook 选择与「每节点一次」；`tapIntent` 全矩阵；poke/gift 的 accent 规则（含冲突改 heart）；pack schema 新字段。
- 集成：§1 的「照提示词办事」假 LLM 走完 arrive→ending；poke / gift 一轮完整走通（Mock）。
- e2e：引导弹幕出现并可点发送；顶部标题随节点变化；说话时点画面能打断（字幕和音频停止、进入倾听）；送礼物出现爱心。
- `pnpm test`、`pnpm typecheck` 全绿；`PROVIDER_MODE=mock pnpm smoke` 通过（显式用 Mock）。

## §9 报告 `docs/tasks/s6l-report.md`
改动文件、每条规则对应测试名、录音结果（录了几条）、未决歧义。

## 关卡 1–5 结论（用户已批准）
1. **YAGNI**：范围即 D48 第 2 项；只做功能 + 朴素样式，视觉交 S6u。
2. **端口/适配器**：引导、标题、hook、事件台词都放角色包数据；poke/gift 走协议 `kind`，服务端转情景说明；Mock 有现成回应。
3. **函数式核心**：advanceRule、`nextGuide`、hook 选择、`tapIntent`、poke/gift accent 规则均为纯函数并单测。
4. **契约式设计**：剧情阶段只认服务端节点；引导只显示当前节点、点过即消失；戳 3s / 礼物 10s 冷却；说话中点击一律打断。
5. **测试奖杯**：新增「照提示词办事」假 LLM 集成测试，防 Mock 掩盖推进类 bug；e2e 覆盖引导、标题、点击打断、礼物。
