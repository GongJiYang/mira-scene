# S2 修复说明

不要 commit，不要改动 `docs/architecture/`。规则不变：说明与测试矛盾时停下来报告，不得修改既有测试的意图。
背景：`docs/tasks/stage-2-report.md` §5.6、§6 中你提出的三个问题。架构师裁定如下（第 3 个问题放到 S3 处理，本次不做）。

## 授权
本次**授权修改 `apps/client/src/state/` 的 reducer 和类型**，仅限下面两条规则。`packages/protocol` 仍然不能改。

## 1. 恢复会话时同步 turnId：挪进 reducer
- 现状：`connection.ts` 第 91 行附近直接用 `useStageStore.setState` 修改 currentTurnId，**绕过了 reducer**。这违反了 D4「所有状态变化只经过 reducer」，而且没有测试覆盖。
- 修改：
  - reducer 中 `SERVER_MESSAGE` 收到 `session` 类型时：`currentTurnId = max(本地 currentTurnId, msg.turnId)`，并照旧应用快照。其余字段不变。
  - **删掉** connection.ts 里那个直接 setState 的代码，改为只 dispatch。
- 测试：
  - 本地为 0，收到 turnId=5 的 session → currentTurnId=5；之后 SUBMIT_TEXT → 6。
  - 本地为 7，收到 turnId=5 的 session → 仍然是 7（不回退）。

## 2. 短按、麦克风失败时卡在 thinking
- 新增动作 `INPUT_CANCELLED(turnId)`：turnId 与 currentTurnId 相同，并且 phase 为 listening 或 thinking 时 → 回到 idle（复用现有的 `toIdle`）；其他情况原样返回（同一个引用）。**currentTurnId 不回退。**
- controller 在以下情况 dispatch `INPUT_CANCELLED(当前 turnId)`，并且**不发送** audio_input：
  - 录音不足 300ms 被丢弃；
  - `pttDown` 时麦克风权限被拒绝或不可用（同时照旧设置 micError）；
  - 录音器的任何失败（MediaRecorder 的 error 事件、得到空 Blob）。
- 测试：
  - reducer：listening / thinking 下的 INPUT_CANCELLED → idle；旧 turnId → 同一个引用；speaking 下 → 不变。
  - controller（假 recorder）：短按 → 最终 phase 为 idle，并且没有发送任何 audio_input；麦克风被拒绝 → phase 为 idle，micError 有值。

## 完成标准
`pnpm test`、`pnpm typecheck`、`pnpm smoke` 全部通过。在 `docs/tasks/stage-2-report.md` 末尾追加「## 修复记录」，内容包括改动的文件、新增的测试，以及确认 connection.ts 不再直接调用 setState 去修改 reducer 管理的字段（附上 grep 结果）。
