# 阶段 S2 任务说明：服务端 + Mock 闭环 + 客户端无头核心

你是执行工程师。架构已确定，你按本文实现。**不要改动 `docs/architecture/`，不要 commit。**
只读背景：`docs/architecture/decisions.md`（重点看 D3、D8、D9、D12、D14）、`docs/tasks/stage-1.md`、`docs/tasks/stage-1-report.md`。
现有代码：`packages/protocol`（契约）、`apps/client/src/state`（纯 reducer，已有 86 个测试）。

## 铁律
1. **如果说明和验收测试互相矛盾，停下来写进报告，不得为了让测试通过而修改测试意图。**
2. **不得修改 `packages/protocol` 的 schema 和 `apps/client/src/state/reducer.ts` 的已有转移规则。** 如果确实需要修改，先在报告里说明理由，不要直接改。
3. 本阶段**不接入任何真实模型**，不读取任何 API Key，`pnpm dev` 在没有 `.env` 的情况下也要能完整跑起来。
4. UI 只做**占位**，不做任何视觉设计，正式 UI 由用户另行设计（D14）。

## 允许新增的依赖
- 服务端：`ws`、`@types/ws`、`tsx`、`@types/node`
- 客户端：`zustand`
- 不得引入其他依赖（包括 express、hono、socket.io、concurrently）。

## 0. 根脚本
- `pnpm dev`：用 `pnpm -r --parallel run dev` 同时启动 server（端口 8787）和 client（vite）。
- vite 配置代理：`/ws` → `ws://localhost:8787`，所以客户端只需连同源的 `/ws`。
- 新增 `pnpm smoke`：运行服务端的冒烟脚本（见 §1.7）。

## 1. apps/server

### 1.1 结构（端口/适配器，D9）
```
src/
  index.ts            # http server + ws 升级到 /ws；GET /health 返回 {ok:true}
  config.ts           # 读取环境变量 PROVIDER_MODE（默认 "mock"）；S2 只支持 mock
  ports.ts            # 端口接口定义
  adapters/mock/      # mockLlm.ts、mockStt.ts、mockTts.ts
  session.ts          # 会话与轮次管理（核心）
  story.ts            # 剧情转移校验
  log.ts              # 结构化日志
test/
scripts/smoke.ts
```

### 1.2 端口（所有方法都必须接收 AbortSignal，D9 + 取消信号贯穿）
| 端口 | 方法 | 说明 |
|---|---|---|
| STTPort | `transcribe(audio: {mime: string, data: Buffer}, signal): Promise<string>` | |
| LLMPort | `streamBeats(ctx: {history: Array<{role: "user"\|"assistant", text: string}>, scene: SceneState, userText: string}, signal): AsyncIterable<unknown>` | 产出**未经校验**的原始 beat 对象，由会话层调用 `parseBeatLenient` |
| TTSPort | `synthesize(text: string, opts: {emotion: Emotion}, signal): Promise<{mime: string, data: Buffer}>` | |

signal 中止后，适配器必须尽快以 AbortError 结束，不再产出数据。

### 1.3 Mock 适配器
**MockLLM**：按「剧情节点 + 关键词意图」生成 2–3 个 beat，每个 beat 之间 `await` 300ms（模拟流式输出，并在等待期间响应 signal）。
- 意图识别（简单关键词即可）：`ask_waiting`（等/谁/为什么）、`ask_photo`（照片/摄影/相机）、`comfort`（没事/陪/别担心）、`greeting`（你好/嗨）、`other`。
- 剧情推进：arrive 节点下，第 2 次用户输入起提议 `story.advance = "probe"`；probe 节点下出现 ask_waiting 或 comfort 时提议 `"reveal"`；reveal 节点下下一次输入提议 `"ending"`。
- 进入 reveal 的那一轮，其中一个 beat 必须带：`media: {type:"video", id:"letter_reveal"}`、`camera:"close_up"`、`fx:"rain_stop"`、`emotion:"sad"`。
- 每个节点、每种意图至少一组台词（中文，Mira 的口吻：克制，不直接说出在等谁）。至少有一个 beat 的 `say` 为空串（无声动作，比如 `action:"sip_coffee"`）。
- 用于测试：导出一个可以注入"每 beat 延迟"和"指定输出"的工厂函数。

**MockSTT**：循环返回预设文本（如「你好」「你在等谁？」「别担心，我陪你等」），延迟 400ms，响应 signal。

**MockTTS（临时占位，A/B 方案尚未决定，不要为此做更多设计）**：生成 16kHz 单声道 PCM16 的 WAV。内容为很轻的正弦音（220Hz，振幅 0.05），时长 = `clamp(字数 × 180ms, 600ms, 6000ms)`；延迟 200ms，响应 signal。`say` 为空串时**不调用** TTS。

### 1.4 会话与轮次（session.ts，本阶段的核心）
- **会话**：`Map<sessionId, Session>`。Session 包含：history、scene（SceneState，初始 arrive / trust 0 / neutral / sit）、`lastTurnId`（初始 0）、当前轮的 `AbortController`、`lastActiveAt`。超过 30 分钟不活跃就清理（每分钟检查一次）。
- **hello**：带有效的 `resumeSessionId` 就恢复会话，否则新建。回复 `session{snapshot}`，turnId 用会话的 lastTurnId。
- **新输入**（`text_input` / `audio_input`）：
  1. `isTurnIdAcceptable(lastTurnId, msg.turnId)` 为 false → 回复 `error{code:"stale_turn", retryable:false}`，忽略这条输入。
  2. 否则：**先 abort 上一轮的 controller**，然后 lastTurnId = msg.turnId，再为新一轮创建 controller。
  3. audio_input → STT → 发送 `transcript`；text_input 直接使用文字。
  4. 逐个消费 LLM 产出的原始 beat → `parseBeatLenient`（warnings 写日志）→ 用本轮内递增的计数器**重写 seq**（不信任 LLM 给的 seq）→ 剧情校验（§1.5）→ 更新 scene 的持续视觉状态 → 发送 `beat`。
  5. **TTS 流水线**：每个 beat 一发出，就立即并发开始合成它的 TTS（不等前一个合成完）；但 `tts_audio` **必须按 seq 顺序发送**（seq1 先合成完也要等 seq0 发出之后再发）。
  6. LLM 流结束，并且所有 tts_audio 都发出之后：发送 `state_snapshot`，再发送 `turn_end{reason:"done"}`；把本轮的用户文本和所有 say 拼起来写入 history。
- **interrupt**：`interruptedTurnId` 等于当前轮时 abort；否则忽略。
- **发送守卫**：每一次发送本轮消息之前都要检查「signal 未中止，并且 turnId === lastTurnId」，否则**不发送**。被中止的一轮**什么都不再发**（包括 turn_end）。
- **任何环节报错**（非 AbortError）：发送 `error{code:"turn_failed", message, retryable:true}`，然后发送 `turn_end{reason:"error"}`。
- 发送函数通过注入的 `send(msg)` 抽象，便于测试使用假的传输层。

### 1.5 剧情校验（story.ts）
允许的转移只有：arrive→probe、probe→reveal、reveal→ending（**每轮最多前进一步**）。不合法的提议直接忽略（把发出的 beat 的 `story` 置为 null），并写一条日志。合法的提议更新 scene.node，并且 trust 加 1（上限 3）。

### 1.6 日志（log.ts）
每个事件输出一行 JSON：`{ts, sessionId, turnId, event, ms?, detail?}`。事件至少包括：turn_start、stt_done、llm_first_beat、beat_sent、tts_done、turn_end、turn_aborted、stale_turn、story_rejected。`ms` 表示距离本轮开始的毫秒数（为 S3 测量延迟打基础）。

### 1.7 冒烟脚本（scripts/smoke.ts，`pnpm smoke`）
在进程内启动服务器（随机端口），用 `ws` 客户端完成下面的流程，**任何一步失败都以非 0 退出码退出**：
1. hello → 收到 session。
2. text_input turnId=1 → 收到至少 1 个 turnId=1 的 beat。
3. **在第 1 轮还没收到 turn_end 时**，发送 text_input turnId=2。
4. 断言：从发出第 2 轮开始，**再也没有收到任何 turnId=1 的消息**（等待 2 秒）。
5. 断言：第 2 轮正常收到 turn_end{done}。
6. 发送 text_input turnId=2（重复）→ 收到 error{stale_turn}。
7. 打印各步耗时。

### 1.8 服务端测试（vitest，使用假 send 和可注入的 Mock）
1. 新输入会 abort 上一轮：上一轮的 Mock LLM 观察到 `signal.aborted === true`。
2. 被中止的一轮在中止之后**发送消息数为 0**（包括 turn_end）。
3. turnId 不递增（相等、更小）→ error{stale_turn}，并且当前轮不受影响、继续完成。
4. **tts_audio 的顺序**：让 seq1 的 TTS 比 seq0 更早完成 → 发送顺序仍然是 seq0、seq1。
5. **两种完成顺序**：LLM 流先结束、TTS 后完成 → turn_end 在最后一个 tts_audio 之后；TTS 都完成之后 LLM 才结束 → turn_end 仍然在最后。
6. LLM 返回的 seq 被重写为 0,1,2…
7. 剧情：arrive→reveal 这类跳级提议被拒绝（beat.story 为 null）；合法的转移更新 node 和 trust。
8. interrupt 消息只中止对应的轮次；interruptedTurnId 不是当前轮时忽略。
9. LLM 抛出非 AbortError → 依次发送 error{turn_failed} 和 turn_end{error}。
10. 恢复会话：hello 带上已有的 sessionId → 返回同一份 scene。

## 2. apps/client 无头核心

### 2.1 结构
```
src/core/
  store.ts          # zustand：持有 S1 的 reducer state，暴露 dispatch
  connection.ts     # WebSocket 客户端
  recorder.ts       # PTT 录音
  audio.ts          # Web Audio 播放控制器
  scheduler.ts      # 纯函数：决定下一个可播放的 beat（可单测）
  controller.ts     # 把以上部分接线，对外提供 4 个意图
src/view/
  useStageViewModel.ts   # 视图模型（D14），UI 只能通过它读写
  PlaceholderStage.tsx   # 占位 UI
```

### 2.2 connection.ts
- 连接同源的 `/ws`。打开后发送 hello（resumeSessionId 从 sessionStorage 读取，读写都要包 try/catch）；收到 session 后保存 sessionId。
- 收到的每条消息：`parseServerMessage` 成功 → dispatch `SERVER_MESSAGE`；失败 → `console.warn`，丢弃。
- 发送时构造信封：`v:1`、sessionId、turnId（取 store 的 currentTurnId）、seq（本连接内递增）、ts。
- 断线：按 1s、2s、4s、8s、10s（上限）退避重连；连接状态（connecting / open / reconnecting）放在一个独立的 zustand slice 里，**不改 reducer**。
- `tts_audio` 消息除了 dispatch 以外，还要交给 audio 控制器。

### 2.3 recorder.ts
- `MediaRecorder`；按 `audio/webm;codecs=opus` → `audio/mp4` → 浏览器默认的顺序选择 mime。
- 麦克风权限被拒绝或不可用：通过 controller 在本地暴露一个 `micError` 状态（独立 slice，不改 reducer），占位 UI 显示一句提示即可。
- 停止后得到 Blob → base64 → 发送 audio_input。录音不足 300ms 时丢弃，不发送（防止误触）。

### 2.4 audio.ts 与 scheduler.ts（重点）
- 单个 AudioContext；在第一次用户手势（pointerdown / keydown）时 `resume()`，用来解锁 iOS。
- 收到 tts_audio：**只有 msg.turnId === 当前 currentTurnId 时**才解码（`decodeAudioData`），解码结果按 seq 存入「已就绪缓冲」；**解码完成时要再检查一次 turnId**，如果已经变了就丢弃（解码是异步的，期间可能被打断）。
- 订阅 store：`audioStopToken` 变化或 `currentTurnId` 变化 → 立即 `stop()` 当前的 source，并清空已就绪缓冲。
- **scheduler.ts（纯函数）**：`pickNextPlayable(state, readySeqs: Set<number>, isPlaying: boolean): {seq: number, silent: boolean} | null`
  - 正在播放 → null。
  - 取 `nextBeatToPlay(state)`；没有 → null。
  - 该 beat 的 `say` 为空串 → `{seq, silent:true}`（无声 beat 不等音频）。
  - 有音频就绪 → `{seq, silent:false}`；否则 → null（继续等待）。
  - 只在 phase 为 thinking 或 speaking 时返回结果。
- 播放：调度器给出结果后，dispatch `BEAT_AUDIO_STARTED(turnId, seq)` 并开始播放；`onended` 时 dispatch `BEAT_AUDIO_ENDED(turnId, seq)`（turnId 用**开始播放时**记下的值，reducer 会丢弃过期的）。无声 beat 停留 1200ms 后 dispatch ENDED。
- 每次 store 变化、每次解码完成、每次播放结束时都运行一次调度。

### 2.5 controller.ts 的意图
| 意图 | 行为 |
|---|---|
| `pttDown()` | 记下旧的 turnId 和 phase → dispatch `PTT_DOWN` → 如果旧 phase 不是 idle，就发送 `interrupt{interruptedTurnId: 旧 turnId}` → 开始录音 |
| `pttUp()` | dispatch `PTT_UP` → 停止录音 → 发送 audio_input（使用当前 turnId） |
| `submitText(text)` | 空白文本忽略 → 记下旧的 turnId 和 phase → dispatch `SUBMIT_TEXT` → 旧 phase 不是 idle 就发送 interrupt → 发送 text_input（使用新的 turnId） |
| `retry()` | dispatch `RETRY` |

### 2.6 视图模型（D14，这是给 UI 设计的契约）
`useStageViewModel()` 返回：
```
phase: "idle" | "listening" | "thinking" | "speaking" | "error"
visual: { emotion, pose, action, camera, fx }
subtitle: string | null
media: { type, id } | null
error: { code, message, retryable } | null
connection: "connecting" | "open" | "reconnecting"
micError: string | null
debug: { turnId, sessionId, lastEvents: string[] }   # 最近 20 条事件
intents: { pttDown, pttUp, submitText, retry }
```
**UI 组件不得直接 import store、connection、audio。** 在文件开头写清楚这条约束。

### 2.7 占位 UI（PlaceholderStage.tsx）
纯文字，不做任何样式设计：大字显示 phase；一行显示 visual 各字段；字幕区；media 不为空时显示 `[media: video letter_reveal]`；文字输入框 + 发送按钮；一个"按住说话"按钮（pointerdown / pointerup / pointercancel / pointerleave，并且按钮外松开也要能结束）；桌面端按住空格同样生效（输入框获得焦点时不触发）；error 时显示重试按钮；折叠的 debug 区。

### 2.8 客户端测试（vitest）
1. `pickNextPlayable` 的每条规则都有用例：正在播放、没有 beat、无声 beat、音频未就绪、音频已就绪、phase 是 idle 或 listening。
2. 乱序就绪：seq1 的音频先就绪而 seq0 未就绪 → 返回 null；seq0 就绪后 → 返回 seq0。
3. controller 的意图（用假 connection、假 recorder）：speaking 时 `submitText` → 先 dispatch，再发 interrupt（携带旧 turnId），然后发 text_input（携带新 turnId）。idle 时 `submitText` → 不发 interrupt。
4. 空白文本不发送任何消息。
5. 视图模型对 phase 的映射。

## 3. 完成标准（全部满足才算完成）
- `pnpm install`、`pnpm test`（包括 S1 原有的 86 个测试）、`pnpm typecheck`、`pnpm smoke` 全部成功。
- `pnpm dev` 能启动；在浏览器里**手动或用你可用的浏览器自动化**验证：输入文字 → 听到占位音 → 字幕出现 → 继续输入能打断。如果无法验证音频，请如实说明。
- 写 `docs/tasks/stage-2-report.md`：文件清单、各命令输出摘要、smoke 的输出、手动验证结果、**与说明不一致的地方**、**你发现的说明歧义或矛盾**，以及视图模型的最终类型定义（原样贴出，供 UI 设计参考）。
- 不要 commit，不要改动 `docs/architecture/`。
