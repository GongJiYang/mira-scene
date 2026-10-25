# 阶段 S1 完成报告

状态：**完成**。单仓骨架、`packages/protocol` 契约包、`apps/client` 纯函数状态机与全部要求单测已实现；`pnpm install` / `pnpm test` / `pnpm typecheck` 均通过。未 commit，未修改 `docs/architecture/`。

## 1. 验收结果

```
$ pnpm install
Scope: all 3 workspace projects
Already up to date
Done in 224ms using pnpm v11.0.9

$ pnpm test
 ✓ apps/client/test/reducer.test.ts (19 tests) 5ms
 ✓ packages/protocol/test/turn.test.ts (3 tests) 1ms
 ✓ packages/protocol/test/messages.test.ts (34 tests) 6ms
 ✓ packages/protocol/test/beat.test.ts (26 tests) 7ms

 Test Files  4 passed (4)
      Tests  82 passed (82)
   Duration  359ms

$ pnpm typecheck
packages/protocol typecheck$ tsc -p tsconfig.json
packages/protocol typecheck: Done
apps/client typecheck$ tsc -p tsconfig.json
apps/client typecheck: Done
```

额外冒烟（非验收项）：

- `pnpm --filter @mira/client build`：Vite 7 构建成功（28 modules）。
- `vite --port 5199 --strictPort` 启动后实测：`/` 返回 `Mira — S1 skeleton` 页面，`/src/main.tsx`、`/src/state/reducer.ts` 正常转译；Chromium 打开页面，标题与 body 均为 `Mira — S1 skeleton`，console errors 为空。
- 说明：本机 5173/5174 已被无关的 Vite 服务占用，`pnpm dev` 会自动改用 5175 并成功启动；为验证本仓库页面，冒烟时用 `--port 5199` 隔离端口。`pnpm dev` 本身工作正常。

## 2. 生成文件清单

根：

| 文件 | 内容 |
|---|---|
| `package.json` | 根 scripts：`dev`（转发 client vite）、`test`（`vitest run`）、`typecheck`（`pnpm -r run typecheck`）；devDeps：typescript、vitest |
| `pnpm-workspace.yaml` | `packages/*`、`apps/*`；`allowBuilds: esbuild: true`（见 §4.1） |
| `tsconfig.base.json` | strict、ESM、Bundler resolution、noUncheckedIndexedAccess、verbatimModuleSyntax 等 |
| `.gitignore` | `node_modules`、`dist`、`.env` |
| `pnpm-lock.yaml` | 安装生成 |

`packages/protocol`：

| 文件 | 内容 |
|---|---|
| `package.json` | `@mira/protocol`，exports 指向 `src/index.ts`；依赖 zod |
| `tsconfig.json` | 继承根配置，include src+test |
| `src/enums.ts` | Emotion / Pose / Action / Camera / Fx / StoryNode / MediaType 的 zod enum 与类型 |
| `src/beat.ts` | `mediaSchema`、`storyStepSchema`、`beatSchema`、`Beat` / `Media` / `StoryStep` |
| `src/scene.ts` | `sceneStateSchema`（trust 0..3 整数等）、`SceneState` |
| `src/lenient.ts` | `parseBeatLenient`（永不抛错）与 `BeatParseResult` |
| `src/messages.ts` | 统一信封、client/server discriminated union、payload schema、两个 parse 函数及类型 |
| `src/turn.ts` | `isTurnIdAcceptable` |
| `src/index.ts` | 统一导出 |
| `test/beat.test.ts` | 合法/非法 beat、逐枚举降级、seq/say 修正、非对象输入（26 例） |
| `test/messages.test.ts` | 11 种 type 各合法+非法用例、信封/SceneState/Beat 约束（34 例） |
| `test/turn.test.ts` | turnId 相等/更小/更大（3 例） |

`apps/client`：

| 文件 | 内容 |
|---|---|
| `package.json` | React 19 + Vite 7；依赖 `@mira/protocol` |
| `tsconfig.json` | React JSX、include src+test |
| `vite.config.ts` | Vite + plugin-react |
| `index.html` / `src/main.tsx` / `src/App.tsx` | 最小页面，仅显示 `Mira — S1 skeleton` |
| `src/state/types.ts` | Phase 判别联合、Visual、ClientState、ClientAction |
| `src/state/reducer.ts` | `initialState`、`reducer`、`nextBeatToPlay` |
| `src/state/index.ts` | state 模块导出 |
| `test/reducer.test.ts` | §2.3 的 1–9 项核心测试 + 补充用例（19 例） |

## 3. 测试与验收项对应

| S1 §2.3 | 测试位置 |
|---|---|
| 1 旧轮次 beat/turn_end/error 在四种 phase 丢弃且返回同一引用 | `reducer.test.ts`「turnId 过滤（D3）」it.each |
| 2 speaking 时 PTT_DOWN | 「打断与输入」第 1 例 |
| 3 打断后迟到旧 turn_end 不置 idle | 「打断后迟到的上一轮 turn_end…」 |
| 4 连续 SUBMIT_TEXT ×3 | 「连续 SUBMIT_TEXT 三次后只接受最后一轮的 beat」 |
| 5 beat 到达不改 visual/subtitle，STARTED 后生效 | 「beat 与视觉/字幕」第 1 例 |
| 6 旧轮次音频回调丢弃 | 「打断后旧轮次的音频回调…」 |
| 7 完整正常流程 | 「一轮完整流程」第 1 例 |
| 8 turn_end 先于最后 ENDED | 「一轮完整流程」第 2 例（见 §5.2） |
| 9 seq 乱序时 nextBeatToPlay=0 | 「seq 乱序到达时…」 |

补充用例：action/camera/fx/media 的 null 保留、重复 seq 忽略、snapshot 不受 turnId 限制且不动 phase、RETRY/PTT_UP 的条件生效、queue 中不存在 seq 的音频回调丢弃。

## 4. 与任务说明不一致之处及原因

1. **`pnpm-workspace.yaml` 增加 `allowBuilds: { esbuild: true }`**。pnpm 11.0.9 默认拒绝执行依赖的 postinstall，`pnpm install` 会以 `ERR_PNPM_IGNORED_BUILDS` 失败，且 `pnpm test`/`pnpm typecheck` 前置的依赖校验也会失败。该配置只放行 esbuild 的构建脚本（vite 的传递依赖），未引入新依赖。
2. **`parseBeatLenient` 对 say、seq、media、story 的修正也写 warning**。说明 §1.2 只在枚举句后写了 warning，但总述为「每处修正都写一条 warning」；按总述实现，测试仅断言枚举降级各产生一条 warning。`media`/`story` 仅在「字段存在但非法」时写 warning；缺失或显式为 null 视为合法的 null。
3. **`SUBMIT_TEXT` 动作不携带 text 字段**。reducer 不负责发送消息，文字内容属于 S2 的传输层；说明只规定了动作名与状态转移，未定义 payload，避免在纯 reducer 中放未使用数据。
4. **协议包通过 exports 直接暴露 `src/index.ts`（无构建产物）**。本阶段没有构建链路，Vite 与 TS 均直接消费 workspace 源码；`typecheck` 因此会连带检查协议源码。
5. **`pnpm typecheck` 实现为 `pnpm -r run typecheck`**，由各包 `tsc -p` 执行；根目录没有可编译的 TS 工程，避免重复配置。client 通过包名导入协议类型。
6. **`BEAT_AUDIO_STARTED` 在 queue 中找不到对应 seq 时返回原 state 引用**（说明未定义该情况，选择丢弃而不是进入无数据的 speaking）。
7. **`parseBeatLenient` 末尾增加 schema 防御性校验**：组装结果若不合法（未来 schema 收紧时）回退为空 beat 并追加 warning，保证「永不抛错且返回值是合法 Beat」。
8. **依赖版本**：zod 3.25、React 19、Vite 7、Vitest 3、TS 5.9，均在允许清单内。
9. 测试用例数量超出最低要求（82 例），未改任何契约语义。

## 5. 说明中的歧义（需要架构侧裁定）

1. **`turn_end` 回到 idle 时 subtitle 是否清空未规定**。§2.2 的 `turn_end` 行只要求 `turnEnded=true` 与可能的 idle；只有 `BEAT_AUDIO_ENDED` 的 idle 分支写了 `subtitle=null`。当前按字面实现：`turn_end` 幂等地置 idle，不清 subtitle。结果是「最后一个 ENDED 先到、turn_end 后到」时 idle 仍残留最后一句字幕；反序（turn_end 先到）时 ENDED 会清空。建议 S2 明确统一为「进入 idle 即清空 subtitle」。
2. **测试 8 与 §2.2 的 `speaking` 条件潜在冲突**。若 turn_end 在最后一个 beat 已 STARTED（queue 已空、phase=speaking）后到达，§2.2 要求立即 idle，与测试 8「要等 ENDED 之后才 idle」矛盾。当前按 §2.2 实现，测试 8 用「queue 中仍有待播 beat」的场景覆盖，可稳定通过。若要覆盖单 beat 播放中的场景，需要额外状态（例如保留在播 seq/不提前从 queue 移除），属于契约变更。
3. **media 的生命周期**。§2.2 只在 STARTED 时「media 非 null 时设置」，只在 PTT_DOWN/SUBMIT_TEXT 清理；没有「播放结束即隐藏」的规则。当前实现中剧情图片/视频会一直保留到下一次输入。若希望媒体在 ENDED 或 turn_end 后淡出，需要新增字段或动作。
4. **error 状态的清理范围未定义**。当前 error 只改 phase，不清 queue/subtitle/visual；RETRY 仅回 idle，保留其余字段。若要求重试前清空本轮残留，需要补充规则。
5. **snapshot 覆盖范围**。§2.2 明确只覆盖 emotion/pose/camera/fx；`action` 不在 SceneState 中，当前保留最近一次 beat 的 action。若服务端快照应重置 action，需要扩展 SceneState 或约定特殊值。
6. **信封 `seq` 与 `tts_audio.beatSeq` 的职责**。reducer 只用 `msg.turnId` 过滤，未使用信封 `seq`；`tts_audio` 用 `beatSeq`。协议层保留二者，S2 需明确 `seq` 的排序语义（当前仅要求非负整数，未要求唯一/递增）。
7. **D4 说 phase「均携带 turnId」**，而 S1 的状态定义使用单一 `currentTurnId`。按 S1 状态表实现（turnId 不进入 phase），以便所有旧轮次判断共用同一入口。
8. **warning 文案未标准化**。当前为中文、包含字段名与非法值；测试只做子串断言。若后续需要上报/展示，建议定义 code。

## 6. 其他

- 已执行 `git init`，未 commit。
- `docs/architecture/` 未改动（仓库是全新 git，改动记录为无）。
- `apps/client/dist` 冒烟后已删除；node_modules 与 Vite 缓存均在 `.gitignore` 覆盖范围内。

## 修复记录

### 改动文件

| 文件 | 改动 |
|---|---|
| `apps/client/src/state/reducer.ts` | 新增 `toIdle()` 统一 idle 清理（`phase=idle`、`queue=[]`、`subtitle=null`；media 保留）；重写 `markTurnEnded()`：仅 `thinking` + `queue` 为空直接回 idle，`speaking` 与其他 phase 只置 `turnEnded`；`error` 增加 `queue=[]`、`subtitle=null`、`audioStopToken+1`；`applyBeatEnded` 与 `RETRY` 的 idle 分支改走 `toIdle()` |
| `apps/client/test/reducer.test.ts` | 恢复测试 #8 原始意图；新增 3 个用例（见下） |

未改动 `docs/architecture/`、`packages/protocol/`，未 commit。

### 测试变化

- **恢复**：`一轮完整流程 > turn_end 先于最后一个 beat 的 ENDED 到达时，要等 ENDED 之后才 idle`
  改为单 beat：`SUBMIT_TEXT → beat seq0 → BEAT_AUDIO_STARTED(0) → turn_end`（断言 phase 仍为 `speaking(0)`、`turnEnded=true`）`→ BEAT_AUDIO_ENDED(0)`（断言 `idle`、`subtitle=null`、`queue=[]`）。
- **新增**：`一轮完整流程 > 多 beat 场景中 turn_end 在第二个 beat 播放期间到达：仍 speaking，第二个 ENDED 后 idle`
  两个 beat 全部到达；`STARTED(0)/ENDED(0)/STARTED(1)` 后收到 `turn_end`，断言 `speaking(1)` 且 `subtitle="第二句"`；`ENDED(1)` 后断言 `idle`、`subtitle=null`、`queue=[]`。
- **新增**：`一轮完整流程 > thinking 状态下未收到任何 beat 就 turn_end → idle，subtitle 为 null`
- **新增**：`打断与输入 > error 清空 queue 与 subtitle，并让 audioStopToken +1`
  前置为播放 seq 0、queue 中仍有 seq 1；error 后断言 phase 为 error、`queue=[]`、`subtitle=null`、token +1。

### 测试输出摘要

```
$ pnpm typecheck
packages/protocol typecheck$ tsc -p tsconfig.json
packages/protocol typecheck: Done
apps/client typecheck$ tsc -p tsconfig.json
apps/client typecheck: Done
```

```
$ pnpm test
 ❯ apps/client/test/reducer.test.ts (22 tests | 1 failed)
   × 一轮完整流程 > SUBMIT_TEXT → 2 个 beat → 依次 STARTED/ENDED → turn_end → idle
     → expected { kind: 'speaking', seq: 1 } to deeply equal { kind: 'idle' }
 ✓ packages/protocol/test/turn.test.ts (3 tests)
 ✓ packages/protocol/test/messages.test.ts (34 tests)
 ✓ packages/protocol/test/beat.test.ts (26 tests)

 Test Files  1 failed | 3 passed (4)
      Tests  1 failed | 84 passed (85)
```

`typecheck` 通过。`pnpm test` **未全绿**，唯一失败是原有的测试 #7，原因是本修复说明内部存在矛盾（见下），按 §0 规则未修改该测试的断言意图。

### 发现的新矛盾（阻塞验收）

**矛盾：修复说明 §1 的 `turn_end` 规则与 §4「原有其他测试保持通过、不得修改断言意图」互斥。**

- 修复说明 §1 规定：phase 为 `speaking` 时收到 `turn_end` 只置 `turnEnded=true`，phase 不变，等最后一个 `BEAT_AUDIO_ENDED` 再回 idle。
- 但测试 #7 `SUBMIT_TEXT → 2 个 beat → 依次 STARTED/ENDED → turn_end → idle` 的顺序是**先** `ENDED(0)`、`ENDED(1)`，**后** `turn_end`。此时：
  1. `ENDED(1)` 到达时 `turnEnded` 仍为 false，`applyBeatEnded` 保持 `speaking(1)`；
  2. 随后 `turn_end` 到达，按 §1 只置 `turnEnded=true`，phase 仍是 `speaking(1)`；
  3. 不会再有下一个 `BEAT_AUDIO_ENDED`，状态永久停在 `speaking(1)`。

实测断言失败：`expected { kind: 'speaking', seq: 1 } to deeply equal { kind: 'idle' }`（`reducer.test.ts:366`）。这不是实现缺陷，而是规则无法区分「最后一个 beat 的音频仍在播放」（§1 要保护的场景）与「音频已结束、仅缺 turn_end」（测试 #7 的场景）：两者在现有状态模型中都是 `phase=speaking`、`queue=[]`、`turnEnded` 分别为 false/true，第 3 步后完全相同，且没有「本 beat 音频已结束」的持久信号。

**需要架构侧二选一（本次未擅自选择）：**

1. 为状态机增加「在播音是否结束」信号（例如 `speaking` 内的 `audioEnded` 标志，或保留已 STARTED 的 seq 直到 ENDED），使「音频已结束」的 `speaking` 在 `turn_end` 时回 idle；这是契约变更，会改动 `ClientState` 形状。
2. 承认测试 #7 的编排（turn_end 最后到达）不在 §1 覆盖范围，修订该测试的顺序或断言；但按 §0 我不得自行修改其意图。

在裁定前，仓库保持：规则按 §1 字面实现，测试 #7 原样保留（失败）。其余改动与新增/恢复测试均通过。

## 第二次修复记录

### 原阻塞矛盾的处理

第一次修复遗留的阻塞点（`turn_end` 在最后一个 `BEAT_AUDIO_ENDED` 之后到达时无事件可回 idle）由新规则消除：`BEAT_AUDIO_ENDED` 在「queue 为空且未 turnEnded」时回 `thinking`，随后的 `turn_end` 再按原有规则（thinking + queue 空 → idle）落到 idle。测试 #7 的编排与断言意图未改动，已自然通过。

### 改动文件

| 文件 | 改动 |
|---|---|
| `apps/client/src/state/reducer.ts` | `applyBeatEnded` 由「queue 空且 turnEnded 才 idle」改为三分支：queue 非空 → 保持 `speaking(seq)`（返回原引用）；queue 空且 `turnEnded` → `toIdle`；queue 空且未 `turnEnded` → `phase=thinking`、`subtitle=null`（其余字段不变）。turnId 不匹配仍直接丢弃。补充规则注释。 |
| `apps/client/test/reducer.test.ts` | 新增 1 例：`一轮完整流程 > 最后一句 ENDED 后 turn_end 未到：进入 thinking（subtitle=null），新 beat 的 STARTED 恢复 speaking` |

未改动 `docs/architecture/`、`packages/protocol/`，未改动任何既有测试的断言意图，未 commit。

### 状态转移（变更后）

| 事件 | 条件 | 结果 |
|---|---|---|
| `BEAT_AUDIO_ENDED` | turnId 不匹配 | 丢弃（原引用） |
| `BEAT_AUDIO_ENDED` | queue 非空 | 保持 `speaking(seq)` |
| `BEAT_AUDIO_ENDED` | queue 空、turnEnded=true | `toIdle`（idle / queue=[] / subtitle=null） |
| `BEAT_AUDIO_ENDED` | queue 空、turnEnded=false | `thinking`，subtitle=null |
| `turn_end` | thinking 且 queue 空 | idle（turnEnded=true） |
| `turn_end` | 其他 | 只置 turnEnded |

失败场景（原测试 #7）现路径：`ENDED(0)`（queue=[1]，保持 speaking 0）→ `ENDED(1)`（queue 空、未 turnEnded → thinking）→ `turn_end`（→ idle）。

### 新增测试断言

- 单 beat `STARTED(0) → ENDED(0)` 后：`turnEnded=false`、`phase={kind:"thinking"}`、`subtitle=null`、`queue=[]`。
- 同轮再收 `beat seq1` + `STARTED(1)`：`phase={kind:"speaking",seq:1}`、`subtitle="第二句"`。

### 验收输出

```
$ pnpm test
 ✓ apps/client/test/reducer.test.ts (23 tests) 6ms
 ✓ packages/protocol/test/turn.test.ts (3 tests) 1ms
 ✓ packages/protocol/test/messages.test.ts (34 tests) 6ms
 ✓ packages/protocol/test/beat.test.ts (26 tests) 7ms

 Test Files  4 passed (4)
      Tests  86 passed (86)
```

```
$ pnpm typecheck
packages/protocol typecheck$ tsc -p tsconfig.json
packages/protocol typecheck: Done
apps/client typecheck$ tsc -p tsconfig.json
apps/client typecheck: Done
```

### 仍待架构侧明确的点

1. `BEAT_AUDIO_ENDED` 进入 `thinking` 时不清 `media`、不动 `audioStopToken`（说明未规定）；`thinking` 期间若有残留媒体仍显示。
2. 若在非 `speaking` phase（例如 `thinking`）收到 `ENDED` 且 queue 为空，当前实现也会落入 `thinking`（幂等）或 `idle`（turnEnded）分支；实际事件序列不会产生该输入。
3. 第一次修复记录中 §5 的歧义（`turn_end` 回 idle 不清 subtitle、error 清理范围、media 生命周期等）仍未由说明裁定，实现保持原样。
