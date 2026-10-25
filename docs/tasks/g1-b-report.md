# G1-b 完成报告：导演层 + 三份契约 + 属性测试

状态：**完成**。未 commit；未修改 `docs/architecture/`（`decisions.md` 等文件的改动在本任务开始前已存在，未触碰）。

## 1. 验收命令

```
$ pnpm typecheck
packages/protocol typecheck: Done
apps/server typecheck: Done
apps/client typecheck: Done

$ pnpm test
 Test Files  14 passed (14)
      Tests  188 passed (188)

$ pnpm smoke
SMOKE OK
总耗时 2614ms；turn2 beats=3 tts=2
```

测试数 153 → 188（+35：导演层 21、属性 3、素材清单 6、mockLlm +2、session +3）。

### 1.1 Q10：无 `.env` 的 `pnpm dev`

```
$ pnpm dev
apps/server dev: {"event":"server_started","detail":{"port":8787,"providerMode":"mock"}}
apps/client dev: VITE ready → http://localhost:5173/

$ curl -s 'http://[::1]:8787/health'                 → {"ok":true}
$ curl -s http://localhost:5173/ | grep title        → <title>凛 — S2 placeholder</title>
$ 经 Vite 代理 ws://localhost:5173/ws：hello → text_input「你在等谁？」
  recv beat 0 {"say":"……你是在问我吗？","emotion":"calm","hands":"cup","fx":"rain_heavy",...}
  recv beat 1 / beat 2（beat 2 为无声 beat，action=sip_coffee）
  recv state_snapshot {"node":"arrive","trust":0,"fx":"rain_heavy","turnCount":1}
  OK beats=3 tts=2
```

验证后已按进程组停止 `pnpm dev`；`pgrep -fl 'mira-scene.*(tsx|vite)'` 无输出（`NO_LEFTOVER`），未留常驻进程。

环境噪音（非仓库问题）：本机 `127.0.0.1:8787` 被无关 Python 进程占用，node 服务绑在 IPv6 `*:8787`，因此健康检查走 `[::1]`；`5173` 的 IPv4 监听属于本机其他进程，Vite 实际走 `localhost`（IPv6）并正常代理。

## 2. 改动与新增文件

### 2.1 `packages/protocol`（只新增导出，未改已有 schema）

| 文件 | 改动 |
|---|---|
| `src/manifest.ts` | **新增**契约 ③ 的类型：`FaceLayers` / `MouthShape` / `CharacterManifest` |
| `src/index.ts` | 仅新增 `export * from "./manifest"` |

`beat.ts`、`enums.ts`、`scene.ts`、`lenient.ts`、`messages.ts` 均未修改。

### 2.2 `apps/server/src/director/`（新增）

| 文件 | 内容 |
|---|---|
| `vocab.ts` | 情绪 → Fish 标签表（neutral 无标签）；动作 → 手部状态表（glance_window → null）；`buildTtsText` |
| `director.ts` | 纯函数 `direct(llmBeat, ctx) → { beats, ctx }`；实现 §2.2 规则 1–5 与不变量 |

设计要点：
- `DirectorContext = { scene, recentActions, advancedThisTurn, beatsThisTurn }`；`recentActions` 保存最近 3 个产出 beat 的 action（含 `null` 占位）。
- 剧情推进复用 `story.ts` 的 `evaluateStoryAdvance` / `advanceScene`；视觉状态用 `applyBeatToScene` 逐 beat 持久化。
- `DirectedBeat = { beat, ttsText }`；`beat.seq` 固定填 0，由会话层分配。
- 剧情推进成功时 `beat.story = { advance: node }`（保留原有客户端语义）。

### 2.3 `apps/server`

| 文件 | 改动 |
|---|---|
| `src/ports.ts` | 仅更新 `LLMPort` 注释为契约 ①（输出仍为 `unknown`） |
| `src/session.ts` | 接入 `parseLlmBeatLenient → direct → 分配 seq → 发送 → ttsText 调 TTS`；session 保存 `recentActions`；新增 `director_decision` 日志；warnings 日志改名 `llm_beat_warning`；删除旧的 `story_rejected` 分支 |
| `src/adapters/mock/mockLlm.ts` | 只输出 `LlmBeat`（say/emotion/suggest/advance）；reveal 轮用 `advance:"reveal"` + `suggest:"show_polaroid"`；修咖啡台词 |
| `test/director.test.ts` | **新增** 21 例：规则 1–5、不变量、迁移的 reveal 验收 |
| `test/director.property.test.ts` | **新增** 3 个 fast-check 属性 |
| `test/mockLlm.test.ts` | 夹具迁移为 LlmBeat；新增「只输出契约 ① 字段」「咖啡台词」用例 |
| `test/session.test.ts` | 夹具迁移为 LlmBeat；新增 ttsText、director_decision、长句切分 3 例 |
| `package.json` | `devDependencies` 新增 `fast-check ^4.10.2` |

`pnpm-lock.yaml` 随之更新（+16 行）。

### 2.4 `apps/client`

| 文件 | 改动 |
|---|---|
| `src/render/manifest.ts` | **新增**契约 ③ 数据：Emotion → 面部贴片，Hands → 手部贴片，眨眼/口型 |
| `test/manifest.test.ts` | **新增** 6 例：全部枚举值有映射且文件真实存在 + D28 固定映射 |

映射（D28）：

| Emotion | base | overlays |
|---|---|---|
| neutral | `master_clean` | 无 |
| calm | `master_clean` | 无 |
| guarded | `master_clean` | `eyelid_half` |
| sad | `master_clean` | `brow_sad`, `mouth_sad` |
| warm | `master_clean` | `mouth_smile`, `blush` |
| surprised | `master_clean` | `brow_raised`, `mouth_o` |

Hands：`cup→arm_cup`、`polaroid→arm_polaroid`、`camera→arm_camera`、`phone→arm_phone`。眨眼 `eyelid_closed`；口型 `closed→null`（主立绘闭嘴）、`small→mouth_small`、`open→mouth_open`。

## 3. 迁移了哪些断言（逐条）

| # | 原位置 / 原断言 | 迁移后 | 说明 |
|---|---|---|---|
| 1 | `apps/server/test/mockLlm.test.ts`「进入 reveal 的那一轮有一个 beat 带 photo_letters / close_up / rain_stop / sad / show_polaroid / polaroid」 | `apps/server/test/director.test.ts` →「导演层：迁移自 mockLlm 的 reveal 验收」 | 仍用 `composeBeats` 产出 probe 轮的 LlmBeat，逐个送入 `direct`，断言 round 内出现 `media:{type:"photo",id:"photo_letters"}`、`camera:"close_up"`、`fx:"rain_stop"`、`action:"show_polaroid"`、`hands:"polaroid"`，并出现 `story.advance="reveal"`。**验收意图完整保留** |
| 2 | `mockLlm.test.ts` 同一用例内的 `emotion:"sad"` 断言 | 同 #1（director 测试） | reveal 轮 mock 现在显式输出 `emotion:"sad"`；导演层只负责 neutral→sad 降级 |
| 3 | `mockLlm.test.ts`「至少一个 beat 是 glance_window 的无声动作」 | 保留在同一文件 | 断言从 `action:"glance_window"` 改为 `suggest:"glance_window"`；无声 beat 的意图不变 |
| 4 | `session.test.ts` 的 `RawBeat`（含 hands/action/camera/fx/media/story/seq） | 同文件 `LlmBeatFixture`（say/emotion/suggest/advance） | 契约 ① 后会话只接受 LlmBeat；视觉字段不再由 LLM 传入 |
| 5 | `session.test.ts`「剧情：跳级被拒绝；合法转移更新 node 与 trust；每轮最多一步」的 `story:{advance}` 夹具 | 同文件改为 `advance` 字段 | 对 `payload.beat.story` 的断言原样保留，仍验证跳级拒绝、trust 递增、每轮一步 |
| 6 | `session.test.ts`「LLM 返回的 seq 被重写为 0,1,2…」的输入 `seq:5/9` | 同文件改为「beat 的 seq 由会话层分配为 0,1,2…」 | LlmBeat 无 seq；断言输出 seq 仍为 `[0,1,2]`，意图不变 |
| 7 | `session.test.ts`「hello 带已有 sessionId」的 `story:{advance:"probe"}` | 同文件改为 `advance:"probe"` | 快照 node/trust/turnCount 断言不变 |

会话测试中原本没有 reveal 视觉字段断言，因此没有需要迁移的 reveal 会话断言。

## 4. 新增测试

| 文件 | 用例 |
|---|---|
| `director.test.ts` | 情绪透传 + 6 种 Fish 标签；空台词 ttsText 为空；4 种 suggest→hands（含 glance_window 保持）；无 suggest 时 action=null；冷却间隔 4 beat；拒绝 suggest 保持 hands；reveal 视觉与 neutral→sad；reveal 非 neutral 保持；ending 视觉；会话首 beat rain_heavy；非法推进无覆盖；每轮一步；trust 上限 3；非规则 3 的 camera/fx/media 为 null；长句切分与视觉只放第一个；≤20 字不切；无标点不切；只有本轮第一句受限；beat 合法且 seq=0；ctx 累计 |
| `director.property.test.ts` | 解析总函数、direct 后置条件/不变量、parse→direct 组合（详见 §5） |
| `manifest.test.ts` | glob 生效；Emotion 全覆盖且 base/overlay 文件存在；Hands 全覆盖且文件存在；眨眼/口型文件存在；D28 固定映射；不引用 `brow_soft` |
| `mockLlm.test.ts` | 只输出 4 个契约字段；reveal 轮 advance+suggest；咖啡台词不出现「给你点」 |
| `session.test.ts` | TTS 收 `ttsText`、下行 `beat.say` 保持原文；`director_decision` 记录采纳结果；长句切成两个 beat（seq 0/1、两条 TTS） |

## 5. 属性测试

`RUNS = 500`，共 **3 个属性 × 500 次 = 1500 次运行**（每次 `pnpm test` 都执行）：

1. **`parseLlmBeatLenient` 总函数**：500 次。生成器覆盖非对象、`null/undefined`、数字/布尔/数组、字段类型错误、坏枚举、5,000 字长串、含引号/反斜杠/emoji 的串。断言不抛错、输出能通过 `llmBeatSchema`、say 为 string、suggest/advance 为合法枚举或 null。
2. **`direct` 后置条件与不变量**：500 次，每次 50–200 个 LlmBeat，按 1–4 个 beat 一组切成多轮连续调用。断言：
   - 永不抛错；每次产出 1–2 个 beat；`beat.seq=0`；每个 beat 通过 `beatSchema`；
   - `ttsText` = 标签 + 台词（空台词为空）；
   - 动作冷却（见 §6 第 1 条的唯一例外）；suggest 映射的手部状态；
   - `camera/media` 只出现在剧情推进 beat；`rain_heavy` 只在会话第一个 beat；`rain_stop`/`media` 只对应 reveal；
   - emotion 透传（reveal 的 neutral→sad 例外）；
   - 剧情节点只进不退、trust 为 0–3 的整数、每轮最多一步、`recentActions` 等于最近 3 个 beat 的 action。
3. **parse → direct 组合**：500 次。任意原始输出经 `parseLlmBeatLenient` 后进入 `direct`，不抛错且输出 beats 合法。

## 6. 歧义、矛盾与实现判断

1. **冷却不变量与 reveal 强制动作冲突（重要）**。§2.2 规则 3 要求进入 reveal 时 `action=show_polaroid`，属性测试又要求「同一个 action 在任意连续 3 个 beat 内最多出现一次」。当随机序列在前 1–2 个 beat 已采纳 `show_polaroid`、紧接着进入 reveal 时，两条要求不可能同时成立。处理：**reveal 强制视觉优先**（验收明确要求 reveal 轮必须出现 show_polaroid），属性测试对 `story.advance="reveal"` 的强制动作豁免冷却断言，其余动作仍严格断言。已在测试注释中标明。若要求绝对冷却，需要允许 reveal 不出现 show_polaroid，或禁止 LLM 在 reveal 前建议 show_polaroid；两者都会改动已确认的验收意图。
2. **「会话第一个 beat」与「仅校验通过时覆盖视觉」**。规则 3 的 rain_heavy 子项写在「只有校验通过时」之下，但 mock 第一轮不推进剧情，若严格按条件执行，整场都不会出现雨。实现为：会话第一个 beat（`turnCount===0 && beatsThisTurn===0`）无条件 `fx=rain_heavy`；camera/media 仍只来自剧情推进。已验证首轮 beat0 带 rain_heavy。
3. **「视觉字段只放在第一个 beat」的范围**。hands/emotion 是非空字段，无法「不放在」第二个 beat。实现为：切分后 `camera/fx/media/action/story` 只在第一个 beat；第二个 beat 的 hands 延续第一个 beat 的结果、emotion 与第一个 beat 相同。
4. **`recentActions` 的表示**。取「最近 3 个 beat」而非「最近 3 个非空动作」，用 `null` 占位。原因：规则原文是「最近 3 个 beat 里出现过」。这样动作间隔 ≥4 个 beat，属性断言（连续 3 个 beat 内最多一次）成立。
5. **切分点选择**。从第 20 个字向前扫，取离上限最近的标点并保留在第一个 beat；`……` 会在第一个 `…` 后切开。找不到标点、或切出空段时不切。
6. **mock 的 reveal 视觉落点**。原 mock 把媒体/镜头放在该轮第一个 beat；现在 advance 仍挂在最后一个无声 beat，导演层在该 beat 上覆盖视觉。验收只要求「那一轮出现」，未要求是第一个 beat。
7. **`director_decision` 的采纳判定**。为保持 `direct` 返回值严格为 `{ beats, ctx }`，会话层从输出反推：有 beat 的 action 等于 suggest → 采纳；有 beat 的 story 等于 advance → 采纳。极少数情况下 suggest 被规则 2 拒绝、但规则 3 同时强制了同一动作（show_polaroid），日志会显示已采纳，与实际生效动作一致。
8. **素材文件名**。`docs/assets-spec.md` 写主立绘命名 `master.png`，仓库实际是 `assets/parts/master_clean.png`；manifest 采用真实存在的 `master_clean`，否则文件存在性测试会失败。`brow_soft.png` 仍在目录中但已废弃，manifest 不引用。
9. **fast-check 只装在 server**。授权允许装到 server 和 client；实际只有 server 侧有属性测试，client 的素材清单用枚举穷举（比属性测试更强），因此没有给 client 增加未使用的依赖。
10. **client 素材存在性检查方式**。client 的 `tsconfig` 只有 `vite/client` 类型、没有 Node 类型，而授权不允许新增 `@types/node`。测试改用 `import.meta.glob("../../../assets/parts/*.png", { eager: true })` 通过 Vite 解析真实文件；新增枚举值却忘记出图时测试同样会失败。
11. **`story.ts` 未改**。剧情校验与 scene 推进仍由 `story.ts` 提供，只是调用方从 `session.ts` 移到了导演层；`applyBeatToScene` 仍被使用。
12. **日志事件改名**。`beat_parse_warning` → `llm_beat_warning`；原 `story_rejected` 被 `director_decision` 取代（detail 含 suggest/advance 及是否采纳）。发送守卫、TTS 串行链、取消逻辑未改。
