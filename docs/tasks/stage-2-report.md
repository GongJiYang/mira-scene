# 阶段 S2 完成报告

状态：**完成**。`apps/server`（HTTP + WS + Mock 适配器 + 会话/轮次/剧情/日志 + 冒烟脚本）与 `apps/client/src/core`、`src/view`（zustand store、WS 客户端、录音、音频播放、纯函数调度器、controller、视图模型、占位 UI）已实现。

- 未修改 `packages/protocol`（schema 与解析函数保持 S1 原样）。
- 未修改 `apps/client/src/state/reducer.ts` 与 `types.ts` 的既有转移规则。
- 未修改 `docs/architecture/`。
- 未 commit。
- 未读取任何 API Key；仓库内无 `.env`，`PROVIDER_MODE` 默认 `mock`（S2 仅支持 mock）。

## 1. 验收命令

```
$ pnpm install
Scope: all 4 workspace projects
Already up to date
Done in 232ms using pnpm v11.0.9

$ pnpm test
 ✓ apps/client/test/scheduler.test.ts (7 tests)
 ✓ apps/client/test/reducer.test.ts (23 tests)      # S1 原 86 个中的 23 个
 ✓ apps/server/test/mockLlm.test.ts (6 tests)
 ✓ packages/protocol/test/turn.test.ts (3 tests)
 ✓ packages/protocol/test/messages.test.ts (34 tests)
 ✓ packages/protocol/test/beat.test.ts (26 tests)
 ✓ apps/server/test/session.test.ts (12 tests)
 ✓ apps/client/test/viewModel.test.ts (7 tests)
 ✓ apps/client/test/controller.test.ts (5 tests)

 Test Files  9 passed (9)
      Tests  123 passed (123)

$ pnpm typecheck
packages/protocol typecheck$ tsc -p tsconfig.json
packages/protocol typecheck: Done
apps/server typecheck$ tsc -p tsconfig.json
apps/server typecheck: Done
apps/client typecheck$ tsc -p tsconfig.json
apps/client typecheck: Done
```

123 = S1 的 86 个（reducer 23 + protocol 63）+ S2 新增 37 个（server 18、client 19）。

## 2. `pnpm smoke` 输出

```
$ pnpm smoke
（结构化日志若干行，含 turn_start / llm_first_beat / beat_sent / tts_done / turn_end /
  turn_aborted(superseded) / stale_turn）
SMOKE OK
┌─────────┬────────────────────────────┬──────┐
│ (index) │ step                       │ ms   │
├─────────┼────────────────────────────┼──────┤
│ 0       │ 'hello → session'          │ 2    │
│ 1       │ 'turn1 → 首个 beat'        │ 1    │
│ 2       │ 'turn2 → turn_end(done)'   │ 608  │
│ 3       │ '打断确认（等待 2s）'      │ 2000 │
│ 4       │ '重复 turnId → stale_turn' │ 3    │
└─────────┴────────────────────────────┴──────┘
总耗时 2620ms；turn2 beats=3 tts=2
```

冒烟脚本在进程内 `startServer({ port: 0 })` 随机端口启动，`GET /health` 返回 `{"ok":true}`；覆盖：hello → turn1 首 beat → 未收到 turn_end 时发 turn2 → 断言 2 秒内无 turnId=1 消息 + turn2 `turn_end{done}` → 重复 turnId=2 收到 `error{stale_turn, retryable:false}`。任一步失败抛错并以退出码 1 结束。

## 3. 文件清单

### 3.1 根

| 文件 | 改动 |
|---|---|
| `package.json` | `dev` 改为 `pnpm -r --parallel run dev`；新增 `smoke`（`pnpm --filter @mira/server run smoke`）；`test`/`typecheck` 不变 |
| `pnpm-workspace.yaml` | 未改（S1 的 `allowBuilds: esbuild` 仍为 install 必需） |
| `pnpm-lock.yaml` | 安装新增依赖后更新 |

### 3.2 `apps/server`（新增包）

| 文件 | 内容 |
|---|---|
| `package.json` | `@mira/server`；deps：`@mira/protocol`、`ws`；devDeps：`@types/ws`、`tsx`、`@types/node`；scripts：`dev`=`tsx watch src/index.ts`、`start`、`smoke`=`tsx scripts/smoke.ts`、`typecheck` |
| `tsconfig.json` | 继承 `tsconfig.base.json`，`lib: ES2024`，`types: ["node"]`，include src/test/scripts |
| `src/index.ts` | `startServer({port?})`：`node:http` + `ws`（`noServer`，只升级 `/ws`，其余 socket 直接销毁）、`GET /health` → `{ok:true}`、其余 404；每连接一个 `send`，`parseClientMessage` 失败只记 `bad_message`；进程内自启动守卫（`pathToFileURL(argv[1]) === import.meta.url`） |
| `src/config.ts` | `loadConfig(env)`：`PROVIDER_MODE` 默认 `mock`，其它值抛错；`PORT` 默认 8787（冒烟用 0） |
| `src/ports.ts` | `STTPort` / `LLMPort`（`AsyncIterable<unknown>`）/ `TTSPort`，全部接收 `AbortSignal`；`LLMContext`/`LLMHistoryEntry` |
| `src/abort.ts` | `AbortError` 构造/识别、`throwIfAborted`、可打断 `sleep`（额外文件，见 §5.1） |
| `src/log.ts` | `Logger` 类型、`createLogger(write)`、`consoleLogger`、`silentLogger`；一行 JSON |
| `src/story.ts` | `createInitialScene()`、`evaluateStoryAdvance()`（只允许下一节点）、`advanceScene()`（node + trust+1 上限 3）、`applyBeatToScene()`（emotion/pose 覆盖，camera/fx 仅非 null 覆盖） |
| `src/session.ts` | 会话 Map、hello（新建/恢复 + 连接重绑）、输入校验、轮次执行、TTS 流水线、发送守卫、interrupt、30 分钟清理（每分钟） |
| `src/adapters/mock/mockLlm.ts` | 关键词意图、4 节点 × 5 意图台词表、2 句台词 + 1 个静音动作 beat、剧情提议、reveal 特写、可注入延迟与输出 |
| `src/adapters/mock/mockStt.ts` | 循环返回预设文本，默认延迟 400ms |
| `src/adapters/mock/mockTts.ts` | 16kHz 单声道 PCM16 WAV，220Hz、振幅 0.05，`clamp(字数×180ms, 600, 6000)`，默认延迟 200ms |
| `test/session.test.ts` | §1.8 的 1–10 项 + `audio_input → transcript`（12 例） |
| `test/mockLlm.test.ts` | 意图识别、节点×意图台词覆盖、剧情提议、reveal 媒体、流式延迟与中止（6 例） |
| `scripts/smoke.ts` | §1.7 冒烟流程与耗时表 |

### 3.3 `apps/client`

| 文件 | 改动 |
|---|---|
| `package.json` | 新增依赖 `zustand`（仅此一个） |
| `tsconfig.json` | `lib` 增加 `ES2024`（`Promise.withResolvers`） |
| `vite.config.ts` | `/ws` → `ws://localhost:8787`（`ws: true`） |
| `index.html` | 标题改为 `Mira — S2 placeholder` |
| `src/core/store.ts` | `useStageStore`（持有 S1 state）+ `dispatch`；独立 slices：`useConnectionStore`（status/sessionId）、`useMicStore`、`useDebugStore`（最近 20 条事件） |
| `src/core/scheduler.ts` | 纯函数 `pickNextPlayable(state, readySeqs, isPlaying)` |
| `src/core/audio.ts` | 单 AudioContext、手势解锁、按 turnId 解码 + 解码后复检、seq 就绪缓冲、token/turnId 变化即停止并清空、播放调度（audio `onended`、静音 1200ms） |
| `src/core/connection.ts` | 同源 `/ws`、hello、`parseServerMessage` → dispatch、信封、tts_audio → audio、1/2/4/8/10s 退避重连、连接状态 slice |
| `src/core/recorder.ts` | MediaRecorder（`audio/webm;codecs=opus` → `audio/mp4` → 默认）、权限失败写 micError、`<300ms` 丢弃、`blobToBase64`；处理「松开早于 getUserMedia 完成」的竞态 |
| `src/core/controller.ts` | `createController({connection, recorder})` 与 4 个意图；单例 `intents` + `bootstrapConnection()` |
| `src/view/useStageViewModel.ts` | 文件头声明「UI 不得直接 import store/connection/audio」；纯映射 `toStageView` + hook |
| `src/view/PlaceholderStage.tsx` | 纯文字占位：phase 大字、visual 一行、字幕、media、输入框+发送、按住说话、重试、折叠 debug |
| `src/App.tsx` / `src/main.tsx` | 渲染占位舞台；启动时 `installAudioUnlock()` + `bootstrapConnection()` |
| `src/state/*` | **未改动** |
| `test/scheduler.test.ts` | 规则 6 条 + 乱序就绪（7 例） |
| `test/controller.test.ts` | submitText 顺序 / idle 不打断 / 空白文本 / PTT 发送 / 丢弃（5 例） |
| `test/viewModel.test.ts` | phase 映射（5 种）+ 字段透传（7 例） |

## 4. 服务端关键实现说明

- **轮次**：`handleInput` 先做 `isTurnIdAcceptable`；合法则 abort 旧 controller → 更新 `lastTurnId` → 新 controller → `runTurn`。`handleMessage` 返回的 Promise 在该轮结束时 resolve（WS 层不 await，因此新输入可并发进入）。
- **发送守卫**：轮内所有发送都经过 `emit`（`closed || signal.aborted || session.lastTurnId !== turnId` 就不发）；`error`/`turn_end` 用 `emitFinal`（只放过 `closed`，即轮内主动终止时仍可发，且仍受中止与轮次校验约束）。被中止轮次零发送。
- **TTS 流水线**：每个 say 非空 beat 一发出就启动 `synthesize`；发送端用 promise 链串行化，因此 1 号先合成完也要等 0 号发完。TTS 失败记为 `failure`，停止消费后续 beat、等链收尾后走 `turn_failed`。
- **完成顺序**：`await ttsChain` 之后才写 history/`turnCount`，再 `state_snapshot` → `turn_end{done}`；因此两种完成顺序下 `turn_end` 都在最后。
- **剧情**：`storyAdvanced` 标记保证每轮最多一步；非法/第二步提议把 `beat.story` 置 null 并记 `story_rejected`（带 `advance` 与 `reason`）。
- **日志事件**：turn_start、stt_done、llm_first_beat、beat_sent、tts_done、turn_end、turn_aborted、stale_turn、story_rejected，另有 turn_failed、beat_parse_warning、session_created/resumed/expired、interrupt_ignored、unknown_session、bad_message、handler_failed、ws_error、server_started。`ms` 为距本轮开始毫秒。

## 5. 与任务说明不一致的地方

1. **新增 `src/abort.ts`**：说明的文件树没有列出它。三个 Mock 适配器与会话层需要同一套 `AbortError` 约定与可打断 `sleep`，否则要重复实现。
2. **服务端 `tsconfig` 用 `lib: ["ES2024"]`；客户端也增加 `ES2024`**：`Promise.withResolvers` 需要 ES2024 类型库。客户端因 `@types/node` 被提升可见，浏览器 `setTimeout` 需写成 `window.setTimeout` 才能保持 `number`。
3. **`pnpm smoke` 实现为 `pnpm --filter @mira/server run smoke`**：说明只要求根脚本存在，未规定实现形式。
4. **服务端 `index.ts` 导出 `startServer({port})` 并带进程内自启动守卫**：冒烟需要在同进程随机端口启动。另加了 `start` 脚本（`tsx src/index.ts`，非必需）。
5. **hello 时中止旧 controller**：说明只写了「恢复会话」。同一会话被新连接绑定时，旧连接上仍在跑的轮次没有意义，因此 abort 后重绑 `send`。
6. **客户端在收到 `session` 时把 `currentTurnId` 提升为 `max(本地, 服务端 turnId)`**：D12 要求 turnId 单调递增，而刷新页面会重置本地计数器（实测：恢复会话 lastTurnId=6 后本地从 0 开始，下一次输入被判 `stale_turn`）。这行只初始化计数器，不改 reducer 转移规则；不修改 reducer 文件。**这是本阶段唯一超出说明字面的行为改动**，建议架构侧确认。
7. **`unknown_session`**：说明未定义「非 hello 消息指向不存在会话」的响应；实现回 `error{code:"unknown_session", retryable:true}`。非法 JSON/schema 只记 `bad_message`，不回复（避免向未知会话发消息）。
8. **信封 `seq` 语义**：说明只要求构造信封。服务端用「每会话单调递增」、客户端用「每连接单调递增」；`beat`/`tts_audio` 的真正顺序信息在 `payload.beat.seq` / `payload.beatSeq`。
9. **TTS 失败走 `turn_failed`（不降级为纯字幕）**：§1.4 规定「任何环节报错」→ error + turn_end(error)；D10 的「TTS 失败 → 仅字幕」属 S5，本阶段按 §1.4 字面实现。失败后不再合成/发送剩余音频，但已发出的 `beat` 保留。
10. **中止/失败轮次不写 history、不增 `turnCount`**：说明只规定完成时写入。
11. **场景状态在 beat 发出时立即更新**：被中止轮次已生效的 `story`/视觉更新不回滚（服务端权威 + 说明要求「更新 scene 的持续视觉状态」）。客户端已丢弃该轮显示，重连快照会以服务端为准。
12. **`pnpm dev` 在本机换端口**：5173/5174 被无关服务占用，Vite 自动用 5175；`/ws` 代理与端口无关。Vite 先于 server ready，首个代理请求会 `ECONNREFUSED`（日志可见），客户端按退避重连后恢复。
13. **占位 UI 的 phase 使用 `style={{ fontSize: "2rem" }}`**：说明要求「大字显示 phase」，仅此一处内联尺寸，无任何其它样式。
14. **空格键额外接受 `event.key === " "`**：`event.code === "Space"` 为主判断；自动化面合成事件的 `code` 为空，补 key 兜底（真实浏览器两者都有）。

## 6. 说明中的歧义与矛盾（未擅自改测试/契约）

1. **短按 PTT / 麦克风不可用会停在 `thinking`**：§2.3 要求 `<300ms` 不发送，§2.5 要求 `pttUp` 无条件 `dispatch PTT_UP`（→ thinking），但服务端根本没收到轮次，不会回 `turn_end`。实测：按住 200ms 松开后 UI 永久 `thinking`；麦克风权限失败同样如此（`micError` 已显示）。建议 S3 定义「未发送输入时回到 idle」或本地 `error`。
2. **`stale_turn` 的 `error.turnId` 取值未定义**：当前用被拒消息的 `turnId`。若被拒消息的 turnId 恰好等于客户端 `currentTurnId`（例如重复提交当前轮），reducer 会把它当作当前轮的 error（S1 只按 turnId 过滤），UI 会进入 error。服务端 smoke 第 6 步正是这种重复，未影响断言，但 UI 语义需裁定。
3. **客户端 `session` 消息与 turnId 计数器**：§1.4 规定 hello 回复的 turnId 用 `lastTurnId`，§2.2 只要求保存 sessionId。刷新/重连后若不同步计数器必然 stale（见 §5.6）。建议在 D12 里补一句「客户端以 hello.turnId 初始化/提升计数器」。
4. **`state_snapshot` 不受 turnId 过滤**（S1 既定）：服务端在轮末发 snapshot，客户端此时 `currentTurnId` 相同，正常；但重连时旧连接的迟到 snapshot 仍会覆盖视觉。S2 未改动，属 S1 契约遗留。
5. **history 拼接分隔符未定义**：实现为 `says.join("\n")`；user 与 assistant 各一条。
6. **`per-beat delay` 与首 beat 时机**：说明写「每个 beat 之间 await 300ms」，实现为「首个 beat 立即产出，后续间隔 300ms」，这也是冒烟能在 turn1 未结束时发 turn2 的前提。
7. **Mock LLM「至少一个 say 为空串」的范围**：说明可读作「整个 Mock 至少一处」；实现为每轮第 3 个 beat 都是静音动作 beat（更稳定地覆盖无声路径与 `action`）。
8. **静音 beat 的 1200ms 与音频长度不同源**：说明明确要求 1200ms 固定停留，因此它与字幕/其它 beat 的节奏无关联，S4 需按视觉需要重新定。
9. **`tts_audio` 的 mime**：说明只要求 `{mime,data}`；Mock 用 `audio/wav`，客户端按浏览器解码，未做 mime 白名单。
10. **Mock TTS 的 A/B 方案未定**（D 文档「待确认问题 2」）：本阶段按说明用 220Hz 正弦占位，端口不受影响。
11. **`pnpm dev` 无 `.env` 可跑**：已满足（`PROVIDER_MODE` 默认 mock，未读取任何 Key）。说明同时要求「S2 只支持 mock」，因此 `PROVIDER_MODE=real` 会直接抛错退出。

## 7. 浏览器验证（手动/自动化）

环境：`pnpm dev`（server 8787 + Vite 5175），Chromium（cmux/PiP 自动化面），无 `.env`。

| 场景 | 结果 |
|---|---|
| 首次连接 | `connection=open`；新建会话 `turnId=0`、`idle`；`recv session t0` |
| 文字输入 → 音频 → 字幕 | 输入「你好」：`idle` → `thinking` → `speaking`；字幕「你来了。」；`emotion=calm pose=hold_cup fx=rain_heavy`；debug 依次 `recv beat t1` / `recv tts_audio t1` / `audio ready t1#0`；结束后 `idle`，`action=sip_coffee`（静音 beat） |
| 播放真实发生 | 字幕停留时长与 WAV 时长一致（8 字 → 1440ms；1200ms 静音计时可区分）；`speaking→…→idle` 只有 `source.onended` 能驱动 |
| 打断 | turn2 `speaking`（字幕「……你是在问我吗？」）时输入新文本：120ms 后 `turnId=3`、`phase=thinking`、字幕清空；最终 debug 只有 `turn_end t1`、`turn_end t3`，**没有 `turn_end t2`**；无错误 |
| 剧情 + 媒体 | probe 节点问「你在等谁？」→ 进入 reveal 的那一轮显示 `[media: video letter_reveal]`，`emotion=sad camera=close_up fx=rain_stop` |
| 会话恢复 | 刷新页面后 `recv session`，turnId 同步为 6，下一次输入为 7 并被接受（修复前会被 `stale_turn` 拒绝） |
| PTT 指针 | 合成 `pointerdown`（按钮）→ `listening`；在按钮外 `window` 派发 `pointerup` → `thinking` |
| 空格 PTT | 合成 `KeyboardEvent(code="Space")` → `listening`，`keyup` → `thinking`；输入框聚焦时不触发（代码路径） |
| 麦克风失败提示 | 注入 `getUserMedia` 抛错 → UI 出现「麦克风不可用：…」 |
| 音频上行链路 | 本机 Chromium 无麦克风设备（`getUserMedia` 抛 `OverconstrainedError`）。用运行时 stub 替换 `MediaRecorder`/`getUserMedia` 后：按住 800ms 松开 → `recv transcript t8` → `beat`/`tts_audio`/`audio ready` → 正常 `idle`。stub 只用于自动化，仓库代码不含 stub |

**无法验证的部分（如实说明）**：
- **听不到实际声音**：自动化面为无头/离屏，无法确认扬声器输出。可确认的是：TTS 音频被 `decodeAudioData` 成功解码（否则不会 `audio ready`/`speaking`）、`AudioBufferSource.start()` 后 `onended` 按时触发、打断时 `stop()` 生效（时间与缓冲时长、静音计时可区分）。
- **真实物理鼠标/键盘未转发到页面**：`tab.mouseDown`/`tab.keyDown` 在该 PiP 面上没有产生页面 `pointerdown`/`keydown`（`window.__ptr` 为空；合成 key 的 `code` 为空）。因此指针与空格改用页面内合成 DOM 事件验证同一条监听路径（React `onPointerDown` / `window` keydown）。
- **真实麦克风录音未验证**：自动化环境无音频输入设备；录音器只验证了「失败提示」与「stub 后的完整上行」两条路径。

## 8. 视图模型最终类型定义（原样）

```ts
export type StagePhase = Phase["kind"];

export type StageError = { code: string; message: string; retryable: boolean };

export type StageView = {
  phase: StagePhase;
  visual: Visual;
  subtitle: string | null;
  media: Media | null;
  error: StageError | null;
  connection: ConnectionStatus;
  micError: string | null;
  debug: { turnId: number; sessionId: string | null; lastEvents: string[] };
};

export type StageViewModel = StageView & { intents: Intents };

export type StageViewInput = {
  stage: ClientState;
  connection: ConnectionStatus;
  sessionId: string | null;
  micError: string | null;
  events: string[];
};

export function toStageView(input: StageViewInput): StageView;
export function useStageViewModel(): StageViewModel;
```

展开别名（UI 设计可直接用）：

```ts
// apps/client/src/state/types.ts（S1，未改）
type Phase =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "thinking" }
  | { kind: "speaking"; seq: number }
  | { kind: "error"; code: string; message: string; retryable: boolean };

type Visual = {
  emotion: "neutral" | "calm" | "guarded" | "sad" | "warm" | "surprised";
  pose: "sit" | "hold_cup" | "look_down" | "lean_in";
  action: "glance_door" | "sip_coffee" | "check_phone" | "smile_softly" | null;
  camera: "wide" | "close_up" | null;
  fx: "rain_heavy" | "rain_stop" | "lights_dim" | "warm_glow" | null;
};

type Media = { type: "video" | "image"; id: string };

type ConnectionStatus = "connecting" | "open" | "reconnecting";

// apps/client/src/core/controller.ts
type Intents = {
  pttDown(): void;
  pttUp(): void;
  submitText(text: string): void;
  retry(): void;
};
```

对应等价形状（D14 契约）：

```ts
{
  phase: "idle" | "listening" | "thinking" | "speaking" | "error";
  visual: { emotion, pose, action, camera, fx };
  subtitle: string | null;
  media: { type, id } | null;
  error: { code, message, retryable } | null;
  connection: "connecting" | "open" | "reconnecting";
  micError: string | null;
  debug: { turnId, sessionId, lastEvents };   // lastEvents 最多 20 条
  intents: { pttDown, pttUp, submitText, retry };
}
```

`useStageViewModel()` 每次渲染返回新对象；`intents` 是模块级稳定单例。

## 9. 其他

- `docs/architecture/` 未修改（仓库无历史提交，所有文件均为 untracked，无法用 `git diff` 展示；本阶段未写入该目录）。
- 未 commit。
- 依赖只新增允许清单内项：`ws`、`@types/ws`、`tsx`、`@types/node`、`zustand`。
- 冒烟后未留下构建产物；`apps/server/node_modules/.bin/tsx` 为 pnpm 安装生成（已被 `.gitignore` 的 `node_modules` 覆盖）。
