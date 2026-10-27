# S6k 任务说明：语境表情 accent（D47）

> 来源：D47（用户决定）+ 关卡 1–5 结论（用户 2026-10-28 批准）。执行者：Command Code（deepseek-v4-flash）。在 S6g-A 合并后的 main 上做；与 S6c-fix1 并行（对方会改 `yunaParams.ts` 的耳朵参数，你**不要**动耳朵相关代码）。

## 铁律
冲突停下写进报告；台词和提示词原样使用（本文给出的提示词新增段逐字插入，不要改写）；Key 只从 `.env` 读取、不得打印；不准 commit；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片；长命令显式传大 timeout，同一命令超时两次就停下写进报告；测试里不发真实网络请求。先写会失败的测试，再改代码。

## §1 协议（`packages/protocol`）
- `enums.ts` 新增 `accentSchema = z.enum(["love","heart","shy","amazed","cry","angry","black","dark","fly_head","fly_pet"])` 与类型 `Accent`。
- `beatSchema` 加 `accent: accentSchema.nullable()`；`llmBeatSchema` 加 `accent: accentSchema.nullish()`。
- `lenient.ts`：`accent` 按 suggest 的方式宽松解析——词表外 / 非字符串 → `null` + warning，永不抛错；`EMPTY_LLM_BEAT` 等默认值补 `accent: null`。所有构造 Beat 的地方（兜底句、busy 句、Mock、测试工厂）补 `accent: null` 或相应值，`pnpm typecheck` 必须全绿。

## §2 导演层纯函数 `apps/server/src/director/accent.ts`
`pickAccent({ suggested, emotion, say, recentAccents }) → Accent | null`，纯函数，规则按顺序：
1. **规则触发**：`suggested` 为空且 `say` 含「熬夜」「没睡」「通宵」任一 → 候选 `dark`。（「@送礼物 → love」不做，挪到 S6i。）
2. **冲突不采纳**（返回 null）：
   - sad × love / heart / fly_head / fly_pet
   - warm × angry / black / cry
   - guarded × love / heart
3. **冷却**（`recentAccents` 为最近的 beat accent 序列，含 null）：fly_head / fly_pet 在最近 10 个 beat 内出现过任一次同名 → null；其余 accent 在最近 3 个 beat 内出现过同名 → null。
- `director.ts`：`DirectorContext` 加 `recentAccents`（保留最近 10 个）；accent 只放在切分后的**第一个** beat，第二个 beat 为 null；记得把输出 ctx 里的 `recentAccents` 更新。
- 会话初始化处给 `recentAccents: []`。

## §3 客户端渲染
- 纯函数 `accentParams(accent, sinceSec, untilSec | undefined) → Record<string, number>`（放 `apps/client/src/render/live2d/` 下，可与 yunaParams 同文件或新文件）：
  - 映射：love→`ParamLove`、heart→`ParamHeart`、shy→`ParamShy`、amazed→`ParamAmazed`、cry→`ParamCry` + 流泪（复用 `tearParams`）、angry→`ParamAngry`、black→`ParamBlack`、dark→`ParamDark`、fly_head→`ParamFlyHead`（**不用** `ParamFlyHead2`）、fly_pet→`ParamFlyPet`。
  - 权重：beat 开始后 0.4s 线性渐入到 1；beat 结束（`untilSec` 有值）后 0.4s 线性渐出到 0。
- `yunaParams` 输入新增 `accent?`、`accentSinceSec?`、`accentEndedSinceSec?`（或等价设计）；与已有效果**取最大值**合并（warm 自带 `ParamShy`、sad 自带 `ParamCry`+泪、首句 `ParamAmazed`、hearts 特效 `ParamHeart`）。
- **修订禁止表**：`FORBIDDEN_KEYS` 只保留 `Param1`–`Param10`；`ParamFlyHead`、`ParamFlyHead2`、`ParamFlyPet`、`ParamBlack`、`ParamDark`、`ParamAngry`、`ParamLove` 改为默认 0、由 accent 控制（`ParamFlyHead2` 始终 0）。输出键集合仍须恒定。
- 外壳：在当前播放 beat 的地方（Live2D 舞台 / store）记录 accent 开始与结束时刻并传入；beat 被打断时按「结束」处理（渐出）。

## §4 提示词（`characters/yuna/prompt.v1.md`，用户已审，逐字插入）
在 `"suggest"` 那一行之后插入一行：
```
- "accent"（可选，大多数句子不要写）：这一句额外的表情，只能是 love（爱心眼）/ heart（头上飘爱心）/ shy（脸红）/ amazed（吓一跳）/ cry（哭出来）/ angry（生气）/ black（脸黑、无语）/ dark（黑眼圈、困）/ fly_head（脑袋飞出去，极度震惊或崩溃）/ fly_pet（宠物飞出来）中的一个。只在这句话的情绪真的到了那一步时才用，同一种不要连着用。
```
示例里只加字段、不改台词：
- `{"say":"……诶？还有人？","emotion":"surprised","suggest":"glance"}` → 加 `"accent":"amazed"`
- `{"say":"草，什么模型。","emotion":"surprised"}` → 加 `"accent":"black"`
若有提示词快照测试 / 版本哈希，相应更新。

## §5 Mock 演示
Mock 剧本（`adapters/mock` 或角色包 content.json 里 Mock 用的 beat）在现有台词上加少量 accent，**不新写台词**：至少覆盖 amazed、black、shy、dark 中的 3 个，且满足 §2 的冲突/冷却规则。

## §6 测试
- 单测：`pickAccent`（规则触发、三组冲突、两档冷却、词表内正常通过）；`parseLlmBeatLenient` 的非法 accent；`accentParams` 渐入/保持/渐出曲线；director 只在第一个 beat 放 accent、`recentAccents` 更新。
- 属性测试（fast-check）：任意 emotion × accent × 时间输入，`Param1`–`Param10` 恒为 0，`ParamFlyHead2` 恒为 0，全部参数在 `COMFORT_RANGES` 内，键集合恒定。
- 集成：Mock 会话里带 accent 的 beat 经服务端到客户端 store 完整保留。
- e2e：新增一张带 accent 的截图（在 ending 视频出现之前截）。
- `pnpm test`、`pnpm typecheck` 全绿；`pnpm smoke` 通过。

## §7 文档
`docs/architecture/decisions.md` 的 D47 下补一行「执行：S6k 已实现，冲突表/冷却/映射见 docs/tasks/s6k.md」。

## §8 报告 `docs/tasks/s6k-report.md`
列出：改动文件、每条规则对应测试名、未决歧义。

## 关卡 1–5 结论（用户已批准）
1. **YAGNI**：做协议 accent + 导演冷却/冲突/规则 + 0.4s 渐变 + 放开禁止表 + 提示词段 + Mock 演示；砍「@送礼物 → love」（挪 S6i）。
2. **端口/适配器**：不碰外部服务；Mock 模式完整可用。
3. **函数式核心**：`pickAccent`、`accentParams` 纯函数；外壳只记 beat 起止时刻。
4. **契约式设计**：词表外 → null + warning；冲突表与冷却如 §2；accent 只在 beat 播放期间生效、前后 0.4s 渐变；与已有效果取最大值；不变量 `Param1–10` 恒为 0。假设：fly_head 用 `ParamFlyHead`。
5. **测试奖杯**：单测 + fast-check 属性 + Mock 集成 + 1 张 e2e 截图；无真实网络。
