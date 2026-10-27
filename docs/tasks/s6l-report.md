# S6l 报告：剧情可感知 + 轻互动（D48 第 2 项）

> 执行者：Command Code（deepseek-v4-flash）。分支 `s6l`（worktree `mira-wt-s6l`）。**未 commit**。
> 任务书：`docs/tasks/s6l.md`。台词 / 弹幕 / 标题逐字使用，未改写、未新写。

## 结论

§1–§9 全部完成。`pnpm test`（820 通过，78 文件）、`pnpm typecheck`（5 包全绿）、
`PROVIDER_MODE=mock pnpm smoke`（SMOKE OK）、`pnpm e2e`（43 通过 / 9 跳过，跳过为本就存在的项目级 skip）全绿。

## 改动文件

### 服务端
- `apps/server/src/prompts/advanceRule.ts`：**§1 重写**。文本按节点生成（`advanceAllowText`），
  arrive 用「用户说过至少 1 轮」（`PROBE_AFTER_USER_TURNS=1`，只看历史用户轮、与 Mock 的 `priorUserTurns>=1` 一致）；
  probe 沿用 trust≥2 / ask_core / 满 8 轮；reveal 沿用两轮后 ending。允许目标恒等于 `NEXT_NODE[node]`。
  新增 `userTurns` 形参。
- `apps/server/src/story.ts`：导出 `NEXT_NODE` 与 `nextStoryNode`。
- `apps/server/src/prompts/renderPrompt.ts`：§1 传 `userTurns`（历史用户轮数，不含本轮）；
  §4 nudge 轮把当前节点 hook 追加进 `scene_notes` 提示。
- `apps/server/src/characters/pack.ts`：§2/§3/§4/§5 schema——`node.streamTitle`（min1）、
  `node.guides`（string[]）、`node.hook`（string）、顶层 `events{poke,gift}`；
  交叉校验：非 ending 节点必须有 guides 与 hook。
- `apps/server/src/ports.ts`：`LLMContext.kind?: "text"|"poke"|"gift"`。
- `apps/server/src/adapters/mock/mockLlm.ts`：§4 nudge 优先说节点 hook（无 hook 回退全局 nudge）；
  §5 poke/gift 走 `pack.events`（emotion=surprised）。
- `apps/server/src/director/accent.ts`：§5 `PickAccentInput.kind/pokeIndex` + `eventAccent`
  （gift→love，poke 轮流 shy/angry；冲突时 gift 改 heart，仍冲突则 null）；仍受冲突表与冷却约束。
- `apps/server/src/director/director.ts`：`DirectorContext.inputKind/pokeIndex`；pickAccent 传 kind；
  gift 第一句 `fx=hearts`（仅当无剧情视觉时）。
- `apps/server/src/session.ts`：`TurnInput.text_input.kind`；poke/gift → `scene_notes` 情景说明
  （`观众戳了你一下` / `观众送了你一个礼物`）+ 中性占位 user_text；poke/gift 不触发换背景检测；
  会话级 `pokeCount` 用于 shy/angry 轮流。
- `apps/server/scripts/record-voices.ts`：§7 新增 `--character <id>`；写入按角色的 manifest
  （`assets/voice/<id>/manifest.json`，与 mockTts 查表一致）；只录缺失条目；hook / poke / gift 台词纳入收集。
- `packages/protocol/src/messages.ts`：§5 `textInputPayload.kind?: "text"|"poke"|"gift"`。

### 客户端
- `apps/client/src/live/storyProgress.ts`（新）：§2 `STORY_NODES` / `storyNodeIndex` / `progressDots`（纯）。
- `apps/client/src/live/guides.ts`（新）：§3 `nextGuide` / `nextGuideFor` / `MAX_VISIBLE_GUIDES=3`（纯）。
- `apps/client/src/live/interaction.ts`（新）：§5/§6 `tapIntent(phase, hitCharacter)`（纯）。
- `apps/client/src/live/interactionHooks.ts`（新）：§3 引导调度（8s、最多 3、只用当前节点）、
  §5 冷却门（poke 3s / gift 10s）、随机观众昵称。
- `apps/client/src/live/characters.ts`：新增 `streamTitles` / `guides` / `hooks` / `eventLines`（原样从 content.json 搬）。
- `apps/client/src/live/danmaku.ts`：`kind: "guide"` + `nickname`；新增 `PRUNE_GUIDES`。
- `apps/client/src/live/Live.tsx`：§2 `StoryHeader`（标题 + 4 进度点，0.3s 淡入）、§6 `StageTapLayer`、
  §3 可点引导弹幕（`DanmakuItem`）、§5 送礼物按钮（桌面 + 手机）、手机短按 → tap。
- `apps/client/src/live/live.css`：剧情头部 / 引导弹幕 / 点击层样式。
- `apps/client/src/live/uiText.ts`：§7 输入框占位改「发条弹幕，或按住麦克风说话」；gift/guideHint/viewerFallback。
- `apps/client/src/state/types.ts` + `reducer.ts`：`ClientState.node`（只认服务端 snapshot / beat.story）。
- `apps/client/src/view/useStageViewModel.ts`：暴露 `node`。
- `apps/client/src/core/connection.ts`：`sendText(text, kind?)`。
- `apps/client/src/core/controller.ts`：意图 `poke` / `gift` / `tapInterrupt`；`POKE_/GIFT_PLACEHOLDER`；
  clearState 对 tap 走 PTT_DOWN（→ 倾听）。
- `apps/client/src/core/interrupt.ts`：`InterruptReason` 加 `"tap"`。

### 数据 / 台词
- `characters/yuna/content.json`：每节点新增 `streamTitle` / `hook` / `guides`（ending hook=""、guides=[]）；
  顶层 `events{poke,gift}`；arrive `ask_core` 第二句改「下播之后脑子特别吵，估计又要熬夜了。」
- `characters/yuna/prompt.v1.md`：STATIC 第一句改成年设定「你是忧奈，22 岁，大学刚毕业，做个人势虚拟主播，粉丝叫你「奈奈」。」
- `assets/voice/yuna/manifest.json` + `clips/*.mp3`：新增 7 条预录（见下）。

### 测试 / e2e
- `apps/server/test/storyAdvance.integration.test.ts`（新）：§1「照提示词办事」假 LLM。
- `apps/server/test/pokeGift.integration.test.ts`（新）：§5 poke/gift 一轮。
- `apps/client/test/s6lPure.test.ts`（新）：§2/§3/§5/§6 纯函数。
- 扩展：`prompts` / `pack` / `accent` / `mockLlm` / `liveUi` 测试；`e2e/s6l.spec.ts`（新）。

## 每条规则 → 测试名

| 规则 | 测试 |
| --- | --- |
| §1 advanceRule 各节点 | `prompts.test.ts` › `advanceRule（S6l §1…）` 各 `it`（arrive/probe trust/ask_core/轮次/reveal→ending） |
| §1 允许目标 = NEXT_NODE（属性） | `prompts.test.ts` › `属性：任意节点下「允许进入 X」的目标恒等于 NEXT_NODE[node]` |
| §1 假 LLM 走完 arrive→ending | `storyAdvance.integration.test.ts` › `四个节点依次出现（推进完全由提示词驱动）` |
| §2 进度点 | `s6lPure.test.ts` › `storyProgress` 两条 |
| §2 顶部标题随节点变 | `e2e/s6l.spec.ts` › `标题随节点从 arrive 变到 probe` |
| §3 nextGuide | `s6lPure.test.ts` › `nextGuide` 四条 |
| §3 引导出现并可点发送 | `e2e/s6l.spec.ts` › `idle 约 8 秒后出现引导弹幕，可点击发送` |
| §4 hook 按节点 + 一次 | `mockLlm.test.ts` › `沉默钩子按节点选择`（arrive/probe/reveal 说 hook；ending 回退） |
| §5 poke/gift accent 规则 | `accent.test.ts` › `poke / gift 的 accent 规则`（gift→love、冲突改 heart、poke 轮流、冷却） |
| §5 poke/gift 一轮（Mock） | `pokeGift.integration.test.ts`（gift 台词 + love + hearts；poke shy→angry；不推进剧情） |
| §5 送礼物 → 爱心 | `e2e/s6l.spec.ts` › `送礼物 → 出现爱心特效` |
| §5/§6 tapIntent 全矩阵 | `s6lPure.test.ts` › `tapIntent 全矩阵` 四条 |
| §6 说话时点画面打断 | `e2e/s6l.spec.ts` › `忧奈说话时点画面 → 打断进入倾听` |
| §2–§5 pack schema 新字段 | `pack.test.ts` › `pack schema 新字段`（streamTitle/guides/hook/events + 缺字段拒绝） |
| §2/§4 数据原样 | `pack.test.ts` › `内容原样搬运`（含新台词/events 抽查） |

## 录音结果（§7）

`pnpm voices:record -- --character yuna`（真实 Fish，**只在此运行一次**）：

- 首次补齐（本地 `tsx` 触发实际录制）：**recorded=7 / skipped=33 / total=40**。
- 复跑确认幂等：**recorded=0 / skipped=40**（已有的不重录）。
- 新增 7 条：arrive hook（calm）「……其实我在想一件事。」；
  probe hook（guarded）「我手机里倒是存着一张老截图。」；reveal hook（sad）「你说，我还要继续播吗。」；
  poke 两句（surprised）；gift 两句（surprised）。
- Fish 无余额 / 网络错误，未绕过任何代码。

## 关卡 1–5 的落点

1. 范围即功能 + 朴素样式；视觉未做美术（点击层、引导条均为最简可用）。
2. 引导 / 标题 / hook / 事件台词全在角色包（content.json + 客户端镜像），poke/gift 走协议 `kind`，服务端转情景说明。
3. advanceRule / nextGuide / hook 选择（Mock）/ tapIntent / poke·gift accent 均为纯函数并单测。
4. 剧情阶段只认服务端节点；引导只显示当前节点、出现即标记不再重复；戳 3s / 礼物 10s 冷却；说话中点击一律打断。
5. 新增「照提示词办事」假 LLM 集成测试；e2e 覆盖引导、标题、点击打断、礼物。

## 未决歧义 / 假设

1. **§1 的「至少 1 轮」语义**：任务说与 Mock 的 `priorUserTurns >= 1` 一致，故判定用**历史**用户轮数
   （不含本轮）——arrive 到 probe 在第 2 轮用户输入后发生。若期望第 1 轮即推进，需改 `renderPrompt` 的 `userTurns` 为 `+1`。
2. **§5 gift「冲突改用 heart」在现有冲突表下退化**：`love` 与 `heart` 被同一组 emotion（sad/guarded）同时禁用，
   因此「love 冲突→heart」在真实表里等价于 null。实现照规则写了回退，但实际不会命中；如需 heart 生效需调整冲突表。
3. **§6 打断只在 speaking 生效**：thinking 时点画面按 `tapIntent` 返回 `none`（不打断、不戳）。任务原文「忧奈说话时」= speaking，据此实现。
4. **角色命中判定用近似包围盒**（画布中间 20%–80% 宽，全高）：Live2D 透明区仍会被判为命中；任务允许「用现有包围盒即可」。
5. **§3「安静」含 listening**：任务说「用户和角色都安静（idle）」——实现只在 `phase === "idle"` 刷引导，
   listening（按住麦克风）时不刷，避免与输入冲突。
6. **场景检测对 poke/gift 关闭**：占位 text 不参与换背景关键词匹配（有意），并在 `scene_notes` 里只给情景说明。
