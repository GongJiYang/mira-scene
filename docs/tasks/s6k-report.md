# S6k 报告：语境表情 accent（D47）

> 执行：Command Code（deepseek-v4-flash）。在 S6g-A 合并后的 main 上做；未改耳朵相关代码（S6c-fix1 并行）。未 commit。
> 验收：`pnpm typecheck` 全绿；`pnpm test`（`npx vitest run`）766 tests / 73 files 全绿；`pnpm smoke` OK（真实模式 DeepSeek + Fish）。

## 改动文件

### §1 协议（`packages/protocol`）
- `src/enums.ts`：新增 `accentSchema`（10 值封闭词表）与类型 `Accent`。
- `src/beat.ts`：`beatSchema.accent = accentSchema.nullable()`；`llmBeatSchema.accent = accentSchema.nullish()`。
- `src/lenient.ts`：`parseBeatLenient` / `parseLlmBeatLenient` 均按 `nullableObject` 宽松解析 accent（词表外 / 非字符串 → null + warning，永不抛错）；`EMPTY_BEAT` / `EMPTY_LLM_BEAT` 补 `accent: null`；`NormalizedLlmBeat` 加 `accent`。

### §2 导演层（`apps/server/src`）
- `director/accent.ts`（新）：纯函数 `pickAccent`，规则触发（熬夜/没睡/通宵 → dark）+ 三组冲突 + 两档冷却（fly_head/fly_pet 10、其余 3）。
- `director/director.ts`：`DirectorContext` 加 `recentAccents`（保留 10）；accent 只放在切分后第一个 beat，第二个 beat 为 null；`ctx.recentAccents` 更新。
- `session.ts`：`Session.recentAccents` 初始化 `[]`、每轮注入 `directorCtx`、从 director 结果回写；三处兜底 beat（fallback / scene_busy / scene_failed/rejected）补 `accent: null`。

### §3 客户端渲染（`apps/client/src`）
- `render/live2d/accentParams.ts`（新）：纯函数 `accentParams(accent, sinceSec, untilSec?)` + `accentWeight`（0.4s 渐入/渐出）+ `ACCENT_PARAM` / `ACCENT_FADE_SEC`；cry 复用 `tearParams` 叠加流泪（按权重缩放）；fly_head 用 `ParamFlyHead`。
- `render/live2d/yunaParams.ts`：输入加 `accent?` / `accentSinceSec?` / `accentEndedSinceSec?`；`FORBIDDEN_KEYS` 只保留 `Param1`–`Param10`；新增 `ACCENT_KEYS`（含恒 0 的 `ParamFlyHead2`）并保证输出键集合恒定；accent 贡献与已有效果**取最大值**合并。
- `state/types.ts` / `state/reducer.ts`：`Visual` 加 `accent`；`initialState`、`applyBeatStarted` 处理 accent（逐句，下一句 null 即清）。
- `live/StageRenderer.tsx`：`accentRef` 记录 accent 起止时刻（beat 打断按「结束」处理渐出），把 `accent` / `accentSinceSec` / `accentEndedSinceSec` 传入 `yunaParams`。
- `live/Live.tsx`：桌面 / 手机根节点加 `data-accent`（供 e2e 观测）。

### §4 提示词
- `characters/yuna/prompt.v1.md`：`"suggest"` 行后逐字插入 `"accent"` 说明行；两个示例只加字段（`amazed` / `black`），台词不变。无快照/版本哈希测试需更新（版本仍 `yuna.v1`）。

### §5 Mock 演示
- `characters/yuna/content.json`：节点 `look.accent` 加值 —— arrive=`amazed`、probe=`black`、reveal=`shy`、ending=`heart`（覆盖 amazed/black/shy 三个，且满足 §2 冲突表）。台词未改。
- `characters/pack.ts`：`nodeSchema.look.accent`（nullish）、`nudgeBeatSchema.accent`（optional）；`NodeLook`/`NudgeBeat` 加 `accent`；解析时 `undefined → null`。
- `adapters/mock/mockLlm.ts`：`composeBeats` 把节点 `look.accent` 放在该轮第一句（不新写台词）。

### 测试
- `packages/protocol/test/beat.test.ts`、`llmBeat.test.ts`、`messages.test.ts`：构造器补 `accent`；新增非法 accent 降级 + 全词表通过的断言。
- `apps/server/test/accent.test.ts`（新）：`pickAccent` 规则触发 / 三组冲突 / 两档冷却 / 词表通过。
- `apps/server/test/director.test.ts`：accent 只在第一个 beat、recentAccents 更新、规则触发。
- `apps/server/test/director.property.test.ts`：`llmBeatArb` 加 accent；断言 `recentAccents == 最近 10 个 beat 的 accent`、被切分的第二个 beat accent 恒 null。
- `apps/server/test/accentIntegration.test.ts`（新）：Mock 会话 → 服务端 beat → 客户端 reducer，`visual.accent` 保留 amazed。
- `apps/client/test/accentParams.test.ts`（新）：渐入 / 保持 / 渐出曲线、映射、`ParamFlyHead2` 不出现。
- `apps/client/test/yunaParams.test.ts`：fast-check 输入加 accent；属性断言 `Param1–10` 恒 0、`ParamFlyHead2` 恒 0、COMFORT_RANGES、键集合恒定；accent 取最大值合并等单测。
- `apps/client/test/reducer.test.ts` / `viewModel.test.ts` / `scheduler.test.ts` / `interruptMatrix.property.test.ts`：visual 补 accent。
- `e2e/s6k.spec.ts`（新）：arrive 第一句 `data-accent=amazed`，截 `e2e/out/s6k-accent[-mobile].png`（在 ending 视频出现之前；断言 `story-video-wrap` 此时不存在）。

## 每条规则对应的测试名

| 规则 | 测试 |
| --- | --- |
| §2 规则触发（熬夜/没睡/通宵 → dark） | `accent.test.ts` →「suggested 为空且台词含触发词「…」→ dark」/「suggested 非空时不做规则触发」/「台词不含触发词且无 suggested → null」 |
| §2 冲突 sad × love/heart/fly_head/fly_pet | `accent.test.ts` →「sad × %s → null」 |
| §2 冲突 warm × angry/black/cry | `accent.test.ts` →「warm × %s → null」 |
| §2 冲突 guarded × love/heart | `accent.test.ts` →「guarded × %s → null」 |
| §2 冷却 3（普通） | `accent.test.ts` →「普通 accent：最近 3 个 beat 内出现过同名 → null；滑出窗口后恢复」 |
| §2 冷却 10（fly_head/fly_pet） | `accent.test.ts` →「fly_head / fly_pet：最近 10 个 beat 内出现过同名 → null；仅 3 个不够」 |
| §2 规则触发同样受冷却 | `accent.test.ts` →「规则触发的 dark 同样受冷却约束」 |
| §2 词表内正常通过 | `accent.test.ts` →「词表内正常通过」/「冲突表外的组合正常通过」/「冷却按同名判定」 |
| §1 lenient 非法 accent | `llmBeat.test.ts` →「D47：非法 accent 降级为 null 并写一条 warning（永不抛错）」；`beat.test.ts` →「非法 accent 降级并写一条 warning」 |
| §1 词表内 accent 保留 | `llmBeat.test.ts` →「D47：词表内的 accent 原样保留（含全部 10 个）」 |
| §2 accent 只放第一个 beat | `director.test.ts` →「accent 只放在切分后的第一个 beat，第二个 beat 为 null」；属性测试 →「被切分的第二个 beat 一律 null」 |
| §2 recentAccents 更新 | `director.test.ts` →「ctx.recentAccents 更新：保留最近 10 个 beat 的 accent」「recentAccents 只保留最近 10 个」；属性测试 →「recentAccents == 最近 10 个 beat 的 accent」 |
| §3 渐入 / 保持 / 渐出曲线 | `accentParams.test.ts` →「accentWeight」三条；`yunaParams.test.ts` →「accentEndedSinceSec 有值 → 0.4s 渐出」 |
| §3 映射（含 fly_head→ParamFlyHead） | `accentParams.test.ts` →「fly_head 用 ParamFlyHead（不用 ParamFlyHead2）」「每个 accent 在稳态下恰好写自己的主参数」；`yunaParams.test.ts` →「fly_head 写 ParamFlyHead，ParamFlyHead2 始终 0」 |
| §3 cry 复用 tearParams | `accentParams.test.ts` →「cry 叠加流泪参数」；`yunaParams.test.ts` →「sad 自带 ParamCry 与 accent=cry 取最大值」 |
| §3 与已有效果取最大值 | `yunaParams.test.ts` →「warm 自带 ParamShy 与 accent=shy 取最大值」「sad 自带 ParamCry 与 accent=cry 取最大值」 |
| §3 修订禁止表 / Param1–10 / ParamFlyHead2 恒 0 / COMFORT_RANGES / 键集合恒定 | `yunaParams.test.ts` →「任意输入：禁止参数与 Param1–Param10 恒为 0」（含 ParamFlyHead2）「任意输入：每个参数都在舒适区间内」「任意两组输入：输出键集合完全相同」 |
| §3 逐句 accent（下一句清空） | `reducer.test.ts` →「D47：accent 逐句生效，下一句为 null 时立即清掉」 |
| §6 集成（服务端 → 客户端 store 保留） | `accentIntegration.test.ts` →「arrive 轮的第一句带 accent=amazed，且经 reducer 后 store.visual.accent 保留」 |
| §6 e2e 截图 | `e2e/s6k.spec.ts` →「arrive 第一句带 accent=amazed，截一张带 accent 的图（ending 视频之前）」 |

## 未决歧义

1. **`pickAccent` 的「suggested 为空」判据**：任务 §2 规则 1 说「`suggested` 为空且 `say` 含熬夜…」。我把「为空」实现为「LLM 未给 accent（accent 为 null）」，并未额外要求 `suggest`（动作）为空——即只要 LLM 没给 accent，台词命中熬夜类词就触发 dark。若你想让「有动作建议时也不触发 dark」，需要补一条判据。
2. **冷却窗口是否含当前 beat**：实现按「传入的 `recentAccents`（此前已产出 beat 的 accent 序列）的最近 N 个」判定。文档写「最近 3 个 beat 内」，未明确是否把当前句计入；当前实现是「往前看 3 个」。
3. **`accentParams` 的 `untilSec` 语义**：任务给的签名是 `accentParams(accent, sinceSec, untilSec?)`，未定义 sinceSec 的参照。我实现为「自 accent 开始的秒数」；`untilSec` 为「beat 结束时自 accent 开始的秒数」（`accentEndedSinceSec`）。外壳据此在打断时按「结束」渐出。
4. **cry 的流泪时间基准**：accent=cry 的流泪用「accent 内时长」采样 `tearParams`（与 sad 用全局 `tSec` 不同）。两者按参数取最大值合并。视觉上无冲突，但若要求「与 sad 完全一致的相位」需另议。
5. **Mock 覆盖了 amazed/black/shy（3 个）+ heart**，未覆盖 dark（否则需新写含「熬夜/没睡/通宵」的台词，违反「不新写台词」）。若必须覆盖 dark，需要用户给一句现成台词或批准改词。
6. **提示词版本号**：`prompt.v1.md` 内容变了但头部版本仍 `yuna.v1`（命中缓存的 STATIC 段实际未变，变的是示例区）。若你希望版本号递增（`yuna.v2`）以标记变更，需明确。
7. **`data-accent` 调试属性**：为 e2e 观测在 `live` 根节点加了 `data-accent`。若不想在生产 DOM 暴露，可改由测试专用查询或移除。

## 验证命令与结果
- `pnpm typecheck`：全绿（protocol / server / client / tools）。
- `npx vitest run`：73 files / 766 tests 全绿。
- `pnpm smoke`：`SMOKE OK`（真实模式，DeepSeek + Fish，无真实网络外的额外请求）。
- e2e：`e2e/s6k.spec.ts` 已写好（需浏览器环境运行；本次未跑 `pnpm e2e`）。
