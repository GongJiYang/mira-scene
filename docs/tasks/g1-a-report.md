# G1-a 完成报告

状态：**完成**。基线 `874011f`；未 commit；未修改 `docs/architecture/`（其中 `decisions.md` 的改动在本任务开始前已存在，未触碰）。

## 1. 验收命令

```
$ pnpm install
Scope: all 4 workspace projects
Already up to date
Done in 250ms using pnpm v11.0.9

$ pnpm test
 ✓ apps/client/test/scheduler.test.ts (7 tests)
 ✓ apps/client/test/reducer.test.ts (30 tests)
 ✓ apps/server/test/mockLlm.test.ts (7 tests)
 ✓ packages/protocol/test/llmBeat.test.ts (10 tests)
 ✓ packages/protocol/test/messages.test.ts (42 tests)
 ✓ packages/protocol/test/beat.test.ts (27 tests)
 ✓ apps/server/test/session.test.ts (13 tests)
 ✓ apps/client/test/controller.test.ts (6 tests)
 ✓ apps/client/test/viewModel.test.ts (7 tests)
 ✓ apps/client/test/recorder.test.ts (1 test)
 ✓ packages/protocol/test/turn.test.ts (3 tests)

 Test Files  11 passed (11)
      Tests  153 passed (153)

$ pnpm typecheck
packages/protocol typecheck: Done
apps/server typecheck: Done
apps/client typecheck: Done

$ pnpm smoke
SMOKE OK
总耗时 2623ms；turn2 beats=3 tts=2
```

测试数 123 → 153（+30：protocol +19、client +9、server +2）。依赖未变，`pnpm-lock.yaml` 未改。

### 1.1 Q10：无 `.env` 的 `pnpm dev`

```
$ pnpm dev          # 无 .env，PROVIDER_MODE 默认 mock
$ curl -s 'http://[::1]:8787/health'      → {"ok":true}
$ curl -s http://127.0.0.1:5175/ | grep title → <title>凛 — S2 placeholder</title>
$ 通过 Vite 代理 ws://127.0.0.1:5175/ws 发 hello
  recv session {"node":"arrive","trust":0,"flags":[],"emotion":"neutral","hands":"cup",...}
```

验证后已停止 `pnpm dev`；`pgrep -fl 'mira-scene.*(tsx|vite)'` 无输出，未留常驻进程。

环境噪音（与仓库无关，如实记录）：本机 `127.0.0.1:8787` 被一个无关 Python 进程占用，node 服务绑在 IPv6 `*:8787`，因此走 `[::1]`；`5173`/`5174` 被其它项目占用，Vite 自动用 `5175`。`/ws` 代理正常。

## 2. 改动文件清单

### 2.1 `packages/protocol`

| 文件 | 改动 |
|---|---|
| `src/enums.ts` | `Pose` → `Hands`（`cup, polaroid, camera, phone`）；`Action` → `sip_coffee, glance_window, check_phone, show_polaroid`；`MediaType` → `photo, video` |
| `src/beat.ts` | `beatSchema.pose` → `hands`；`mediaSchema` 增加可选 `url`；新增 `llmBeatSchema` / `LlmBeat`（契约 ①，`suggest`/`advance` 为 `nullish`） |
| `src/scene.ts` | `SceneState.pose` → `hands` |
| `src/lenient.ts` | `parseBeatLenient` 读 `hands`，非法值降级 `cup`；新增 `parseLlmBeatLenient`（永不抛错）与 `NormalizedLlmBeat` / `LlmBeatParseResult` |
| `src/messages.ts` | 下行新增 `media_ready`、`pong`；上行新增 `ping`；新增对应 payload schema 与类型 |
| `test/beat.test.ts` | hands 重命名 + 新增「旧 pose 不被读取」用例 |
| `test/messages.test.ts` | hands 重命名；新增 ping/media_ready/pong 正反例 |
| `test/llmBeat.test.ts` | **新增**：LlmBeat 宽松解析 10 例 |

### 2.2 `apps/client`

| 文件 | 改动 |
|---|---|
| `src/state/types.ts` | `Visual.pose` → `hands`；新增动作 `INPUT_CANCELLED(turnId)` |
| `src/state/reducer.ts` | `session` 消息内 `currentTurnId = max(本地, msg.turnId)`（D4：回到 reducer）；新增 `INPUT_CANCELLED` 转移（复用 `toIdle`，turnId 不回退）；`media_ready` / `pong` 在 turnId 过滤之前原样忽略；视觉字段改用 `hands` |
| `src/core/connection.ts` | **删除** `useStageStore.setState` 直接同步 turnId，改为只 `dispatch`；仅保留连接 slice 的 `useConnectionStore.setState` |
| `src/core/controller.ts` | 短按/空录音/录音器失败 → `INPUT_CANCELLED` 且不发 `audio_input`；`recorder.start()` 返回 false（权限拒绝/不可用）→ `INPUT_CANCELLED`（micError 仍由 recorder 写入） |
| `src/core/recorder.ts` | 监听 MediaRecorder `error`：置失败标记；`stop()` 在 `error` 或 `stop` 抛错时解析为 `null`，不会挂在等 `stop` 事件 |
| `src/view/PlaceholderStage.tsx` | 占位 UI 显示 `hands=` |
| `index.html` | 标题 `Mira — S2 placeholder` → `凛 — S2 placeholder` |
| `test/reducer.test.ts` | 重命名 + 新增 session turnId / INPUT_CANCELLED / media_ready·pong 用例 |
| `test/controller.test.ts` | 丢弃录音后断言 idle；新增麦克风被拒用例；`resetStores` 重置 micError |
| `test/recorder.test.ts` | **新增**：MediaRecorder error → `stop()` 返回 null |
| `test/scheduler.test.ts` / `test/viewModel.test.ts` | 字段重命名 |

### 2.3 `apps/server`

| 文件 | 改动 |
|---|---|
| `src/adapters/mock/mockLlm.ts` | 剧本改为夏凛；意图新增 `ask_radio`；关键词按 §3；reveal 那一轮带 `photo_letters` + `show_polaroid` + `polaroid`；probe 无声 beat 为 `glance_window`；流程规则（`proposeStory`、3-beat 结构）未变 |
| `src/story.ts` | 初始 `hands:"cup"`；`applyBeatToScene` 使用 `beat.hands` |
| `src/session.ts` | `ping` 直接忽略（心跳逻辑 G1-c），不进 `handleInput` |
| `test/mockLlm.test.ts` | 意图/台词覆盖加 `ask_radio`；reveal 断言改 photo_letters 等；新增 glance_window 无声 beat 用例 |
| `test/session.test.ts` | RawBeat 字段重命名；新增 ping 无下行消息用例 |

### 2.4 `docs`

- 新增本文件；`docs/tasks/stage-2-report.md` 末尾追加「## 修复记录」（按 `stage-2-fix.md` 的完成标准）。

## 3. 因重命名而修改的测试断言（逐条）

枚举/字段重命名（断言意图不变）：

| 文件 | 原断言/夹具 | 新值 | 原因 |
|---|---|---|---|
| `protocol/test/beat.test.ts` | `pose:"hold_cup"` | `hands:"cup"` | Pose→Hands 字段与取值 |
| 同上（enumCases） | `{field:"pose", patch:{pose:"stand"}, expected:{pose:"sit"}}` | `{field:"hands", patch:{hands:"stand"}, expected:{hands:"cup"}}` | 非法 hands 降级 `cup` |
| 同上 | 非法 media id `letter_reveal` | `photo_letters` | 剧本媒体 id 改名 |
| 同上 | 合法 media id `letter_reveal` | `photo_letters` | 同上 |
| 同上 | 非对象空 beat `pose:"sit"` | `hands:"cup"` | 同上 |
| `protocol/test/messages.test.ts` | scene `pose:"sit"` | `hands:"cup"` | 同上 |
| 同上 | beat `pose:"lean_in"` | `hands:"polaroid"` | `lean_in` 无对应取值，取手部持拍立得 |
| `client/test/reducer.test.ts` | `makeBeat` `pose:"sit"` | `hands:"cup"` | 同上 |
| 同上 | `makeSnapshot` `pose:"look_down"` | `hands:"phone"` | `look_down` 无对应取值，取看手机 |
| 同上 | beat 夹具与期望 `pose:"look_down"` / `action:"glance_door"` | `hands:"phone"` / `action:"glance_window"` | 枚举改名（glance_door→glance_window） |
| 同上 | 第二条 beat 同上 + `media:{type:"image"}` | `hands:"phone"` + `media:{type:"photo"}` | MediaType `image`→`photo` |
| 同上 | `pose:"hold_cup"`（输入与期望） | `hands:"cup"` | 同上 |
| `client/test/scheduler.test.ts` | beat `pose:"sit"` | `hands:"cup"` | 同上 |
| `client/test/viewModel.test.ts` | visual `pose:"look_down"` | `hands:"phone"` | 同上 |
| `server/test/session.test.ts` | `RawBeat.pose?: string`、夹具 `pose:"sit"` | `hands?: string`、`hands:"cup"` | 同上 |
| `server/test/mockLlm.test.ts` | reveal 断言 `media:{type:"video",id:"letter_reveal"}` | `media:{type:"photo",id:"photo_letters"}` + `hands:"polaroid"` + `action:"show_polaroid"` | §3 剧本要求 |

### 3.1 超出「纯重命名」的断言修改（说明 + 理由）

按铁律 1 在此显式列出，均可在第 6 节找到裁定依据：

1. `client/test/reducer.test.ts`「session / state_snapshot…」：删除 `expect(afterSession.currentTurnId).toBe(state.currentTurnId)`，改为只断言 phase/visual；把 `currentTurnId` 不变的断言移到 `state_snapshot` 上。理由：`stage-2-fix.md` §1 明确要求 session 把本地 turnId 提升为 `max(本地, 服务端)`，旧断言与新验收规则直接冲突；未通过放宽实现来迁就旧断言。
2. `client/test/controller.test.ts`「录音被丢弃…」：期望 `thinking` → `idle`。理由：`stage-2-fix.md` §2 明确「短按/麦克风失败后回到 idle」，并在该节写了对应测试；旧断言意图（不发送 audio_input）保留并加强（新增 turnId 不变断言）。
3. `server/test/mockLlm.test.ts` 意图夹具：`"这张照片是谁拍的？"` → `"能看看照片吗"`，`"别担心，我陪你等"` → `"我陪你坐一会儿"`。理由：这两条旧夹具分别含 `谁` / `等`，会先命中 `ask_waiting`（旧代码同样如此，属于原本就名不副实的夹具）；`INTENTS` 循环现在要求逐意图覆盖，因此改成只命中目标意图的输入。断言意图（每种意图都能产出 2–3 个 beat 且含无声 beat）不变。
4. `server/test/mockLlm.test.ts` 关键词测试：`"我们去摄影吧"` → `"带拍立得了吗"`、`"相机借我看看"`、`"能拍一张吗"`。理由：§3 新关键词表为 `照片/拍立得/相机/拍`，不再包含「摄影」；改为新词表内的输入，并新增两条 `ask_radio` 关键词断言。

## 4. 新增的测试

| 文件 | 用例 |
|---|---|
| `packages/protocol/test/llmBeat.test.ts` | 合法原样保留；`suggest`/`advance` 缺省或 null → null；非法 emotion → neutral；非法 suggest/advance → null；say 缺失/非字符串 → `""`；5 种非对象输入不抛错 |
| `packages/protocol/test/messages.test.ts` | 合法 `ping`、`media_ready`(ready 带 url / fallback)、`pong`；非法 `media_ready`（缺 storyEventId、status 非法、media.type=`image`）、`ping payload` 非对象 |
| `packages/protocol/test/beat.test.ts` | 旧字段 `pose` 不被当作 `hands`（降级 `cup` 且 warning 指向 `hands`） |
| `apps/client/test/reducer.test.ts` | session：本地 0 + turnId 5 → 5，随后 SUBMIT_TEXT → 6；本地 7 + turnId 5 → 7（不回退）。`INPUT_CANCELLED`：listening/thinking → idle 且 turnId 不变；旧 turnId → 同一引用；speaking → 同一引用。`media_ready` 不按 turnId 过滤且原样忽略（turnId 999 / 1 都返回同一引用）；`pong` 原样忽略 |
| `apps/client/test/controller.test.ts` | 麦克风被拒：phase=idle、micError 有值、零发送 |
| `apps/client/test/recorder.test.ts` | MediaRecorder `error` 且无 `stop` 事件 → `stop()` 解析为 `null` |
| `apps/server/test/session.test.ts` | `ping` 不产生任何下行消息 |
| `apps/server/test/mockLlm.test.ts` | probe 的无声 beat 为 `glance_window` 且 `say=""`；`INTENTS` 覆盖新增 `ask_radio` |

覆盖对照：`stage-2-fix.md` 要求的 reducer 两例、controller 两例全部实现；额外补了录音器 error 与协议层用例。

## 5. `stage-2-fix.md` 验收结果

### 5.1 恢复会话时在 reducer 内同步 turnId

- `apps/client/src/state/reducer.ts:74-84`：`session` 分支 `currentTurnId: Math.max(state.currentTurnId, message.turnId)`，并照旧 `applySnapshot`，其余字段不变。
- `connection.ts` 中的直接写入已删除。
- 测试：`reducer.test.ts`「恢复会话时同步 turnId（S2 修复 1）」两例通过。

grep 证明（`connection.ts` 不再直接改 reducer 管理的字段）：

```
$ grep -rn "useStageStore.setState" apps/client/src
apps/client/src/core/store.ts:8:  useStageStore.setState((state) => reducer(state, action));

$ grep -n "setState" apps/client/src/core/connection.ts
40:  useConnectionStore.setState({ status });
87:      useConnectionStore.setState({ sessionId: message.sessionId });
```

说明：`store.ts:8` 是唯一写入口 `dispatch`；`connection.ts` 仅剩连接 slice（`status`/`sessionId`）的写入，这两个字段不属于 reducer 状态（D14）。`currentTurnId` 的唯一写入点是 reducer。

### 5.2 `INPUT_CANCELLED`

- `types.ts:36` 新增动作。
- `reducer.ts:163-169`：`turnId === currentTurnId` 且 phase 为 `listening`/`thinking` → `toIdle(state)`；其余返回同一引用；`currentTurnId` 不回退。
- `controller.ts:27`（麦克风不可用）、`controller.ts:39`（短按 / 空 Blob / 录音器失败）dispatch，且不发 `audio_input`。
- `recorder.ts:57-59` error 事件置 `failed`；`:95-119` `error`/`stop` 抛错均解析 `null`，不会因等不到 `stop` 挂起。
- 测试：reducer 3 例、controller 2 例、recorder 1 例通过。

## 6. 歧义、矛盾与实现判断

1. **既有测试与新说明冲突（已按铁律 1 记录）**：`stage-2-fix.md` 要求的行为（session 提升 turnId、短按回 idle）与本仓库两条旧断言相反。处理：实现按新说明，旧断言按其意图重新落到正确对象（`state_snapshot` 不再提升 turnId；丢弃录音仍不发 `audio_input`），差异见 §3.1。未为了通过测试而放宽 reducer/controller 实现。
2. **`g1-a.md` 的测试授权只覆盖枚举/字段重命名**，但 §3 必然带来台词、媒体 id（`photo_letters`）与 `ask_radio` 夹具的变化，涉及 §3.1 第 3/4 条与 reveal 断言。已逐条列出；断言意图未反转。
3. **`ask_radio` 不触发剧情推进**：为满足「剧情推进规则不变」，`proposeStory` 仍只在 `probe + (ask_waiting|comfort)` 提议 reveal。只聊电台不会推进剧情；如这是非预期，需要另立规则。
4. **`media_ready.media.url?` 的实现位置**：复用 `beat.mediaSchema` 并加可选 `url`，因此 `Beat.media` 也允许 `url`。备选是给 `media_ready` 单独定义 media schema，但那会重复 `type/id` 定义。
5. **心跳范围**：`ping`/`pong`/`media_ready` 只定义 schema；服务端收到 `ping` 直接忽略、不回 `pong`；客户端把 `pong`/`media_ready` 在 turnId 过滤前原样忽略（`media_ready` 不受 turnId 约束，C 状态机在 G1-c）。
6. **`INPUT_CANCELLED` 与打断的交互**：`PTT_DOWN` 已经 bump turnId 并（在活跃轮次时）发 interrupt；麦克风失败后只回到 idle，`currentTurnId` 按规则不回退。若用户紧接着再按 PTT，旧取消回调用 turnId 相等守卫，不会误伤新一轮。
7. **`stage-2-fix` 的「录音器任何失败」落点**：MediaRecorder `error`、空 Blob、`stop()` 抛错统一由 recorder 收敛为 `null`，controller 只处理 `null` 分支，避免在两处重复判定。
8. **角色名替换范围**：仓库内唯一的角色名是 `apps/client/index.html` 标题（已改「凛」）；日志中没有 `Mira`。`sessionStorage` 键 `mira.sessionId` 是存储键，不是角色名，未改；`@mira/*` 包名与仓库名按要求保留。
9. **reveal 那一轮的手部**：`photo_letters` 所在 beat（该轮第 1 个 beat）带 `action:"show_polaroid"` + `hands:"polaroid"`；该轮第 2/3 个 beat 仍按 probe 的 `hands:"cup"`。§3 只要求「有一个 beat 带上」，未要求整轮保持。
10. **环境端口**：见 §1.1，`8787`(IPv4)/`5173`/`5174` 被本机无关进程占用，属环境状态；仓库配置未改。
