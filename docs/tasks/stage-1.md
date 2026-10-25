# 阶段 S1 任务说明：单仓骨架 + 协议包 + 客户端状态机

你是本项目的执行工程师。架构由架构师确定，你按本文实现，**不要改动 `docs/architecture/`**。
背景（只读参考）：`docs/architecture/decisions.md`，重点看 D3、D4、D5、D12。

## 项目一句话
移动端优先的网页互动场景：用户在雨夜咖啡馆与角色 Mira 用文字或语音对话，角色说话、变换表情和动作，并能被用户打断。本阶段**不做 UI、不做服务端、不接任何模型**，只打地基。

## 技术约束
- Node 22，pnpm workspace，TypeScript strict 模式，ESM。
- 允许的依赖：`zod`、`vitest`、`typescript`、`vite`、`react`、`react-dom`、`@vitejs/plugin-react`、`@types/react`、`@types/react-dom`。**不得引入其他依赖。**
- 先执行 `git init`（如果还没有初始化），**不要 commit**。
- 添加 `.gitignore`（node_modules、dist、.env）。

## 目录结构
```
package.json            # 根：scripts: dev, test, typecheck
pnpm-workspace.yaml     # packages/*, apps/*
tsconfig.base.json
packages/protocol/      # 前后端共享契约
apps/client/            # Vite + React（本阶段只需能启动的空页面 + state 模块）
```

## 1. packages/protocol

用 zod 定义 schema，并导出由 schema 推导出的 TS 类型。

### 1.1 枚举
| 名称 | 取值 |
|---|---|
| Emotion | neutral, calm, guarded, sad, warm, surprised |
| Pose | sit, hold_cup, look_down, lean_in |
| Action | glance_door, sip_coffee, check_phone, smile_softly |
| Camera | wide, close_up |
| Fx | rain_heavy, rain_stop, lights_dim, warm_glow |
| StoryNode | arrive, probe, reveal, ending |
| MediaType | video, image |

### 1.2 Beat（一句台词及其指令）
| 字段 | 类型 | 说明 |
|---|---|---|
| seq | 非负整数 | 本轮内的序号，从 0 开始 |
| say | string | 台词，可以为空串（无声动作 beat） |
| emotion | Emotion | 必填 |
| pose | Pose | 必填 |
| action | Action \| null | |
| camera | Camera \| null | |
| fx | Fx \| null | |
| media | `{type: MediaType, id: string}` \| null | |
| story | `{advance: StoryNode}` \| null | 只是提议，服务端会校验 |

**宽松解析函数 `parseBeatLenient(input: unknown)`**：返回 `{ beat, warnings: string[] }`，**永不抛错**。
- 非法 emotion 退回 `neutral`；非法 pose 退回 `sit`；其他非法枚举字段退回 `null`；每处修正都写一条 warning。
- say 缺失或不是字符串时退回空串。seq 非法时修正为 0，并写一条 warning。
- 输入根本不是对象时：返回一个 neutral/sit 的空 beat，加上一条 warning。

### 1.3 SceneState（服务端权威的场景状态）
`node: StoryNode`、`trust: 0..3 的整数`、`flags: string[]`、`emotion`、`pose`、`camera`、`fx`（当前持续的视觉状态，后三者可为 null 的字段照搬 Beat）、`turnCount: 非负整数`。

### 1.4 消息信封
所有消息：`{ v: 1, type, sessionId: string, turnId: 非负整数, seq: 非负整数, ts: number, payload }`，用 zod discriminated union，以 `type` 区分。

客户端 → 服务端：
| type | payload |
|---|---|
| hello | `{ resumeSessionId?: string }` |
| text_input | `{ text: string }`（非空，最长 500） |
| audio_input | `{ mime: string, dataBase64: string }` |
| interrupt | `{ interruptedTurnId: 非负整数 }` |

服务端 → 客户端：
| type | payload |
|---|---|
| session | `{ snapshot: SceneState }` |
| transcript | `{ text: string }`（用户语音的识别结果） |
| beat | `{ beat: Beat }` |
| tts_audio | `{ beatSeq: 非负整数, mime: string, dataBase64: string }` |
| turn_end | `{ reason: "done" \| "interrupted" \| "error" }` |
| state_snapshot | `{ snapshot: SceneState }` |
| error | `{ code: string, message: string, retryable: boolean }` |

导出 `ClientMessage`、`ServerMessage` 两个 schema 及类型，另外提供 `parseClientMessage` / `parseServerMessage`（返回 zod safeParse 结果）。

**turnId 规则（D12）**：turnId 由客户端分配、单调递增。导出纯函数 `isTurnIdAcceptable(lastSeen: number, incoming: number): boolean`，只有 `incoming > lastSeen` 时返回 true，供服务端使用。

### 1.5 协议包测试（vitest）
- 合法 beat 能解析；每个枚举字段的非法值都能按 1.2 降级，并产生 warning。
- 非对象输入不抛错。
- 两个信封 union 对每种 type 各有一个合法用例和一个非法用例。
- `isTurnIdAcceptable` 的边界：相等、更小、更大。

## 2. apps/client 状态机（`apps/client/src/state/`）

**纯函数 reducer**，不引入 zustand（下一阶段再接入），不碰 DOM 和音频。

### 2.1 状态
```
phase: 判别联合
  { kind: "idle" }
  { kind: "listening" }          # 用户按住说话中
  { kind: "thinking" }           # 已提交输入，等待第一个 beat
  { kind: "speaking", seq }      # 正在播放第 seq 个 beat 的音频
  { kind: "error", code, message, retryable }
currentTurnId: number            # 初始 0
queue: Beat[]                    # 已收到但还没开始播放的 beat，按 seq 排序
turnEnded: boolean               # 当前轮是否已收到 turn_end
subtitle: string | null
visual: { emotion, pose, action, camera, fx }   # 初始 neutral / sit / null...
media: { type, id } | null
audioStopToken: number           # 每次需要立即停止音频时 +1，供下一阶段的音频控制器订阅
```

### 2.2 动作（Action）与转移规则
| 动作 | 规则 |
|---|---|
| `PTT_DOWN` | **打断入口**。在任何 phase 下：currentTurnId+1；清空 queue；turnEnded=false；subtitle=null；media=null；audioStopToken+1；phase → listening |
| `PTT_UP` | 只在 listening 时生效：phase → thinking（turnId 不变，录音属于这一轮） |
| `SUBMIT_TEXT` | 在任何 phase 下：执行与 PTT_DOWN 完全相同的清理（currentTurnId 只 +1 一次），区别是 phase → thinking |
| `SERVER_MESSAGE(msg)` | **先判断：msg.turnId !== currentTurnId 时直接丢弃，state 原样返回**（同一个引用）。session / state_snapshot 类型不受此限制（它们不属于某一轮，见下）|
| ├ beat | 按 seq 插入 queue（seq 重复则忽略）。不更新 visual 和 subtitle（这些要等音频开始才生效）|
| ├ turn_end | turnEnded=true；若 queue 为空且 phase 是 thinking 或 speaking → idle |
| ├ error | phase → error |
| ├ session / state_snapshot | 用 snapshot 覆盖 visual 的持续字段（emotion、pose、camera、fx），不动 phase |
| └ 其他 | 原样返回 |
| `BEAT_AUDIO_STARTED(turnId, seq)` | turnId 不匹配就丢弃。从 queue 取出该 seq 的 beat：subtitle=say；visual 应用 beat 的字段（emotion、pose 总是覆盖；action/camera/fx 为 null 时保持原值）；media 非 null 时设置；phase → speaking(seq) |
| `BEAT_AUDIO_ENDED(turnId, seq)` | turnId 不匹配就丢弃。若 queue 为空且 turnEnded → idle、subtitle=null；否则保持 |
| `RETRY` | 只在 error 时生效 → idle |

导出：`initialState`、`reducer(state, action)`，以及 `nextBeatToPlay(state): Beat | null`（queue 中 seq 最小的那个）。

### 2.3 必须通过的单测（这是本阶段的核心验收项）
1. 旧轮次的 beat、turn_end、error 在 idle/listening/thinking/speaking 各个 phase 下都会被丢弃，并返回同一个 state 引用。
2. speaking 时 PTT_DOWN：phase=listening，queue 为空，turnId+1，audioStopToken+1，subtitle=null，media=null。
3. 打断后迟到的旧轮次 turn_end 不会把 phase 改为 idle。
4. 连续 SUBMIT_TEXT 三次后，只接受最后一轮的 beat。
5. 收到 beat 时 visual 和 subtitle 不变；BEAT_AUDIO_STARTED 之后才生效。
6. 旧轮次的 BEAT_AUDIO_STARTED / ENDED（音频回调迟到）会被丢弃。
7. 一轮完整的正常流程：SUBMIT_TEXT → 2 个 beat → 依次 STARTED/ENDED → turn_end → idle。
8. turn_end 先于最后一个 beat 的 ENDED 到达时，要等 ENDED 之后才变为 idle。
9. seq 乱序到达（先 1 后 0）时，nextBeatToPlay 返回 seq 0。

## 3. apps/client 页面
Vite + React 的最小页面，只显示「Mira — S1 skeleton」。确保 `pnpm dev` 能启动。

## 4. 完成标准（全部满足才算完成）
- 根目录 `pnpm install`、`pnpm test`、`pnpm typecheck` 全部成功。
- 上面列出的测试全部存在并且通过。
- 写一份 `docs/tasks/stage-1-report.md`，内容包括：生成的文件清单、`pnpm test` 的输出摘要、与本说明不一致的地方及原因、你认为说明中有歧义的地方。
- 不要 commit，不要修改 `docs/architecture/`。
