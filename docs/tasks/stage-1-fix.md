# S1 修复任务说明

你是执行工程师。本次只修改 `apps/client/src/state/` 和 `apps/client/test/`，**不要改动 `docs/architecture/` 和 `packages/protocol/`，不要 commit。**
背景：`docs/tasks/stage-1.md`（原始说明）、`docs/tasks/stage-1-report.md`（上次的报告）。

## 规则（本次及以后都适用）
**如果说明与验收测试互相矛盾，必须停下来，在报告里写明矛盾，不得为了让测试通过而修改测试的意图。**

## 1. 修正 turn_end 的规则（缺陷）
现状：phase 为 speaking 且 queue 为空时收到 turn_end 会立即变成 idle。但最后一个 beat 在 `BEAT_AUDIO_STARTED` 时已经出队，此时它的音频**还在播放**，所以角色会在说话时被显示为待机。这是错误的。

新规则：
| 情况 | 结果 |
|---|---|
| phase 为 thinking，queue 为空 | turnEnded=true，phase → idle，subtitle=null（这一轮没有任何 beat，比如空回复） |
| phase 为 speaking | 只设置 turnEnded=true，**phase 不变**；等最后一个 `BEAT_AUDIO_ENDED` 时再按原规则转为 idle |
| 其他 | 只设置 turnEnded=true |

## 2. 统一"回到 idle"的清理
任何路径转为 idle 时都要清理：subtitle=null，queue=[]。media **不清理**（媒体的生命周期在 S4 定义）。

## 3. error 的清理范围
收到当前轮的 error 时，除了 phase → error，还要：queue=[]，subtitle=null，audioStopToken+1（立即停止正在播放的音频）。

## 4. 测试
- **恢复测试 #8 的原始意图**：SUBMIT_TEXT → beat seq0 → `BEAT_AUDIO_STARTED(0)` → turn_end（**断言 phase 仍是 speaking**）→ `BEAT_AUDIO_ENDED(0)` → 断言 idle，且 subtitle 为 null。
- 新增：thinking 状态下没有收到任何 beat 就收到 turn_end → idle。
- 新增：多 beat 场景中，turn_end 在第二个 beat 播放期间到达 → 仍是 speaking；第二个 ENDED 之后 → idle。
- 新增：error 会清空 queue、清空 subtitle，并让 audioStopToken+1。
- 原有其他测试保持通过，**不得修改它们的断言意图**。

## 5. 完成标准
- `pnpm test` 和 `pnpm typecheck` 全部通过。
- 在 `docs/tasks/stage-1-report.md` 末尾追加「## 修复记录」，列出改动文件、新增和恢复的测试名称、测试输出摘要，以及发现的任何新矛盾。
