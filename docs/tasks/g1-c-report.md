# G1-c 完成报告：状态机 B / C + 连接层补充

状态：**完成**。未 commit；未修改 `docs/architecture/`（`decisions.md`、`discussion.md` 的改动在本任务开始前已存在，本次未触碰）；未留常驻进程。

## 1. 验收命令

```
$ pnpm typecheck
packages/protocol typecheck: Done
apps/server typecheck: Done
apps/client typecheck: Done

$ pnpm test
 Test Files  22 passed (22)
      Tests  249 passed (249)

$ pnpm smoke
SMOKE OK
hello → session 2ms / turn1 首 beat 1ms / turn2 turn_end 603ms
重复 turnId → stale_turn 7ms / ping → pong 0ms
总耗时 2618ms；turn2 beats=3 tts=2
```

测试数 188 → 249（**+61**）。原有 188 个测试文件与断言**一行未改**（`git status` 中没有任何既有测试文件被修改）。

### 1.1 Q10：无 `.env` 的 `pnpm dev`（含令牌与心跳）

`pnpm dev` 启动后（`VITE v7.3.7` → `http://localhost:5173/`，服务端 mock 模式）：

```
$ curl http://localhost:5173/session-token     → 200 {"token":"IFNTn…","expiresAt":…}
$ 浏览器打开 http://localhost:5173/            → connection=open（说明先取令牌 + 带 ?token= 升级成功）
$ 输入「你在等谁？」                            → speaking，subtitle「……你是在问我吗？」
$ 16s 后 debug 事件：recv pong t1；nudge@1792953819278 · 12s 无输入，主动行动挂起（未发送）
$ idle 占位 UI：performance 行 action=check_phone（8s 待机小动作）、（她似乎想说点什么）
$ 下一轮说话期间采样 performance 行：mouth closed→small→open 循环，
  观测间隔 101–136ms（满足 90–140ms）；hands transition 0.00 → 0.42 → 落位 cup
```

验证后已停止 `pnpm dev`；`pgrep -fl 'mira-scene.*(tsx|vite)'` 无输出（`NO_LEFTOVER`）。
环境噪音（与本任务无关，任务开始前即存在）：`127.0.0.1:8787` 被一个 Python 进程监听，`127.0.0.1:5173` 被一个无关 node 进程监听（IPv4）；node 服务实际绑 IPv6，Vite 的 `localhost` 与代理均正常。

## 2. 改动的文件

### 2.1 新增

| 文件 | 内容 |
|---|---|
| `apps/client/src/state/performance.ts` | 状态机 B：纯 reducer + 常量 + 面部贴片映射（`faceForEmotion` 返回副本） |
| `apps/client/src/state/storyMedia.ts` | 状态机 C：纯 reducer + 按 `storyEventId` 去重 + phase 镜像 |
| `apps/client/src/core/performanceClock.ts` | 表演时钟：60ms 帧循环驱动眨眼/待机小动作/12s nudge；口型用独立 90–140ms 定时器；B 的 zustand store；A→B 接线（phase、beat look） |
| `apps/client/src/core/storyMediaLink.ts` | C 的 zustand store；`media_ready` → C；A 的 phase → C 的可展示判定 |
| `apps/client/src/core/heartbeat.ts` | 心跳常量（15s/30s）、`isHeartbeatExpired`、±20% 退避抖动 `jitteredDelay` |
| `apps/server/src/tokens.ts` | 握手令牌内存表：随机 24 字节、30 分钟 TTL、过期清理 |

### 2.2 修改

| 文件 | 改动 |
|---|---|
| `apps/client/src/core/connection.ts` | 连接前 `fetch("/session-token")` 并带 `?token=`；15s ping；30s 无 pong → 关闭连接走现有重连；退避加 ±20% 抖动；`media_ready` 直接送 C；pong 刷新 `lastPongAt` |
| `apps/client/src/core/controller.ts` | `recordNudge`（日志 + `useNudgeStore.pending`）；PTT/文字输入时清空 pendingNudge；`bootstrapConnection` 启动表演时钟与 C 接线 |
| `apps/client/src/view/useStageViewModel.ts` | 只**新增**输出字段 `performance` / `storyMedia` / `pendingNudge`（输入字段可选，缺省取 B/C 初始状态；已有字段与签名语义未变） |
| `apps/client/src/view/PlaceholderStage.tsx` | 占位 UI 显示新增字段（任务允许「占位 UI 可以显示这些新字段」） |
| `apps/client/vite.config.ts` | dev 代理新增 `/session-token`（生产同源部署不需要） |
| `apps/server/src/config.ts` | `SESSION_TURN_LIMIT` / `DAILY_TURN_LIMIT`（默认 30 / 300，非法值抛错） |
| `apps/server/src/session.ts` | 会话/每日限额；超出时 `error{quota_exceeded, retryable:false}` 且**不创建 controller、不调用 Provider**；每日按本地自然日重置；ping 注释更新 |
| `apps/server/src/index.ts` | `GET /session-token`；WS 升级校验 `?token=`，缺失/无效返回 401；ping 在传输层回 pong；单条消息 >2MB → 日志 + `ws.close(1009)`；新增可选 `logger` 注入 |
| `apps/server/scripts/smoke.ts` | 先取令牌再连接；新增 ping → pong 步骤 |
| `pnpm-lock.yaml` | 未变（本次未新增依赖） |

`packages/protocol` **未改动**：B/C 所需的类型（`FaceLayers`、`MouthShape`、`Media`、`Hands` 等）G1-b 已导出，本批没有需要新增的导出。

状态机 A 的 `state/reducer.ts`、`state/types.ts`、`core/scheduler.ts`、`core/audio.ts`、`core/store.ts`、`state/index.ts` 未改。

## 3. 新增测试（61）

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `apps/client/test/performance.test.ts` | 20 | B 的 5 条 phase 规则；idle 眨眼帧序列（open→half→closed→half→open，60ms/帧）；待机小动作只执行一次与手部映射；打断时**面部立即切换** + **手部 200ms 过渡**（进度 0→0.5→落位，已在 cup 时不多余过渡）；thinking 2s 后补 sip_coffee 且只补一次/重进重置；speaking 表情/手部/动作/口型循环；error brow_raised；同 phase 重复到达不重置 idleSince |
| `apps/client/test/storyMedia.test.ts` | 12 | **四种到达顺序**：ready 先于 speaking 结束、ready 晚于 speaking 结束、ready 时 A 在 listening、显影中被新一轮打断（不作废）；失败 fallback→shown；storyEventId 去重（重复 READY/FALLBACK/REQUEST）；不同事件先后展示；另一张显影中不被覆盖；phase 镜像 |
| `apps/client/test/performanceClock.test.ts` | 9 | 眨眼 2s/6s 边界与 2–6s 重排；非 idle 不眨眼；8s 待机小动作一次且来自 D28 候选集；**12s nudge** 一次、开始新一轮后重新计时、非 idle 不计时；口型间隔 90–140ms（含越界 random 夹取） |
| `apps/client/test/heartbeat.test.ts` | 5 | 15s/30s 常量；29.999s 不断线、30s 判定断线；退避 ±20%（0.8x/1x/1.2x 与区间）；越界 random 夹取 |
| `apps/client/test/viewModelAdditions.test.ts` | 3 | 新增字段缺省值；B 眨眼/口型/手部过渡/动作与 C 媒体状态透传；既有字段保持不变 |
| `apps/server/test/connection.test.ts` | 5 | `/session-token` 随机令牌 + 30 分钟过期；**令牌缺失 401、无效 401**；有效令牌升级 + hello；**ping → pong**（无 hello 也回）；**>2MB → 1009 关闭并写 `message_too_large` 日志** |
| `apps/server/test/sessionQuota.test.ts` | 4 | **会话限额**：第 3 轮 `quota_exceeded/retryable:false`、无 beat/turn_end、Provider 调用次数不增；**全站每日限额**跨会话累计；自然日重置；`stale_turn` 优先于限额 |
| `apps/server/test/tokens.test.ts` | 3 | 令牌校验与 30 分钟过期；缺失/未知令牌拒绝；每次发放不同令牌且过期清理 |

## 4. 实现要点

### B：表演

- 纯 reducer 接收 `PHASE` / `BEAT_STARTED` / `TICK` / `BLINK` / `MOUTH_TICK` / `IDLE_ACTION`，不含定时器、随机数或 DOM。
- 时钟只决定「何时」：60ms 帧循环负责 `TICK`、2–6s 眨眼、8s 待机小动作、12s nudge；口型用独立 90–140ms `setTimeout`（若复用 60ms 节拍会被量化到 120–180ms，超出规格）。
- 随机数经注入的 `rng` 取得；测试里用固定值（0 / 0.999999 边界）。
- 打断：`PHASE listening` 内同步切 `face=CAMERA_FACE`、嘴闭合、清空 `activeAction`，手部生成 `handsTransition{from,to:"cup",startedAt,progress}`；`TICK` 按 200ms 线性推进，完成后 `hands=cup`、过渡清空（若已在 cup，直接取消未完成过渡，避免 cup→cup 淡入）。
- 12s nudge 每次 idle 段只产出一次，交给 controller 记日志与 `pendingNudge`；**不发送服务端**。

### C：剧情媒体

- `none → developing → ready → shown`，失败 `→ fallback → shown`；`processed` 表按 `storyEventId` 去重。
- `media_ready` 在 `connection.handleMessage` 里直接调用 `handleMediaReady`，**不经过 A 的 turnId 过滤**（A 的 reducer 仍原样忽略该消息，既有测试保持）。
- ready/fallback 到达时若 A 不在 speaking/listening 直接 `shown`，否则排队，等下一次 phase 变化到可展示状态再 `shown`。显影中的 A 中断/新一轮不改 C。

### 连接层

- 心跳：WS open 后每 15s `ping`；`lastPongAt` 为 open 时刻或最近 pong；`now - lastPongAt >= 30s` 判定断线并 `close()`，走既有重连。
- 重连退避：原 1/2/4/8/10s 基础上乘 `0.8 + 0.4*Math.random()`。
- 令牌：`GET /session-token` → `{token, expiresAt}`（内存，30 分钟）；升级路径校验，缺失/无效写 `upgrade_rejected` 日志并回 401；客户端每次连接尝试取新令牌。
- 2MB 上限在 schema 校验之前判断（`RawData` 字节数），超限写 `message_too_large` 并 `ws.close(1009)`。
- ping/pong 在传输层完成，会话层仍不产生 pong —— 保留既有占位测试「会话层 ping 无下行消息」的意图。

## 5. 歧义、矛盾与实现判断

1. **C 的 ready → shown 条件自相矛盾**：§2 同一段既写「条件：A 不处于 speaking 或 listening」，又写「否则排队，等下一次 idle 再显示」。实现取**显式条件**（不在 speaking/listening 即可展示，thinking/error 也算），测试按条件断言；若坚持「只能 idle 展示」，需要把 `isShowable` 改成 `phase === "idle"`（一处改动，但会让 thinking 期间排队更久）。
2. **「看镜头」没有对应素材**：manifest 只按 Emotion 映射贴片，没有单独的看镜头差分。实现为 listening 用 `neutral` 主立绘（直视镜头）+ 嘴闭合；thinking 用 `base + eyelid_half`、error 用 `base + brow_raised`，都是直接组合贴片而非走 Emotion 表（D28 表里 error 的 `brow_raised`、thinking 的 `eyelid_half` 并不对应完整情绪）。
3. **B 的输入「开始播放的 beat」拿不到完整 beat**：A 在 `BEAT_AUDIO_STARTED` 时已把该 beat 出队，只留下 `visual`。接线层因此传 `BeatLook{emotion,hands,action}`（恰为 B 需要的三个字段），而不是完整 `Beat`。
4. **B 状态字段多于任务清单**：除要求的 `face/blink/mouth/hands/activeAction/idleSince` 外，还有 `phase`、`phaseSince`、`blinkFrame/blinkFrameAt`、`handsTransition`（任务明确要求）、`thinkingSipDone`、`idleActionDone`。其中 phase/phaseSince 是规则（口型、2s sip、12s nudge）的簿记，否则无法在纯 reducer 内判断。
5. **C 的进入边本批无服务端来源**：服务端 S4 才发 `media_ready`。C 仍定义 `REQUEST`（none→developing）供测试与 S4 接入；运行时只消费 `media_ready`。同一时刻只允许一张：显影/排队期间新的 `REQUEST` 或另一 `storyEventId` 的 `READY` 被丢弃。
6. **去重口径**：`REQUEST` 留下的 `developing` 标记不能拦同一事件的后续 `READY/FALLBACK`；只有已经到过 `ready/shown/fallback` 的事件才完全忽略。测试覆盖了重复 READY/FALLBACK/REQUEST。
7. **心跳超时只在客户端判定**：服务端不主动断开静默客户端（任务只要求客户端判超时）。`lastPongAt` 以 open 时刻为初值，因此令牌错/服务端异常时首次 30s 也会触发重连。
8. **令牌不是一次性**：任务只要求「随机、内存保存、30 分钟过期」。客户端每次连接/重连都取新令牌；旧令牌在过期前仍可用。
9. **限额计数口径**：在「接受一轮」时计数（含随后被中断/失败的轮次），`stale_turn` 优先于限额；每日按**本地自然日**重置；环境变量非法值直接抛错，不静默降级。默认 30/300。
10. **nudge 的 12s 起点**：取 A 回到 idle 的时刻（她说完话之后才开始计沉默），而不是用户上一次输入时刻；任务原文「A 处于 idle 且用户 12s 没有任何输入」两者都满足，但取更自然的「说完后的沉默」。用户下一次输入清空 `pendingNudge`（任务只说记录，清空是为了让视图反映当前状态，否则会永久为 true）。
11. **授权边界的 3 处越界（均为功能必需，已在 diff 中标明）**：
    - 新增 `core/storyMediaLink.ts`：授权只点名「表演时钟、连接心跳」，但 `media_ready 直接送进 C` 与 ready→shown 需要接线，故单独成文件（没有可复用的授权模块）。
    - 修改 `vite.config.ts`：dev 下 `/session-token` 若不代理，客户端取令牌必 404，Q10「无 `.env` 可完整使用」不成立；生产同源部署不依赖此项。
    - 修改 `PlaceholderStage.tsx`：任务明确写「占位 UI 可以显示这些新字段」。
12. **口型节拍不能复用 60ms 帧循环**：实测 60ms 节拍会把 90–140ms 量化成 120–180ms，超出规格；改为独立定时器后浏览器实测间隔 101–136ms。眨眼帧仍由 60ms 节拍推进（任务只要求「约 60ms」），实际每帧 60–120ms。
13. **待机小动作候选**：取 D28 的「看窗外 / 喝咖啡 / 看手机」（`glance_window/sip_coffee/check_phone`），不含 `show_polaroid`（那是剧情媒体动作）。
14. **`handsTransition.from`**：取自过渡开始时的 `hands`（不是视觉上的贴片队列）。若上一段过渡未完成就再次切目标，新过渡从当前 `hands` 起重算 200ms；若目标就是当前 `hands`，直接取消过渡。
