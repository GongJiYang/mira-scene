# S1 第二次修复说明

只修改 `apps/client/src/state/` 和 `apps/client/test/`，不要 commit，不要改动 `docs/architecture/` 和 `packages/protocol/`。
规则不变：说明与验收测试矛盾时，停下来报告，不得修改测试意图。

## 背景
上次修复后，测试「SUBMIT_TEXT → 2 个 beat → 依次 STARTED/ENDED → turn_end → idle」失败。这是**说明的缺陷**，不是你的错：最后一个 beat 播放结束时还没收到 turn_end，phase 就停在 speaking；之后 turn_end 到达，按规则只设置标记，没有任何后续事件能让它回到 idle。

## 新规则：`BEAT_AUDIO_ENDED(turnId, seq)`
（turnId 不匹配就丢弃，这一点保持不变）
| 条件 | 结果 |
|---|---|
| queue 为空，turnEnded=true | → idle（走 `toIdle`） |
| queue 为空，turnEnded=false | → phase **thinking**（服务端可能还在生成下一句），subtitle=null |
| queue 非空 | phase 保持 speaking(seq)，等待下一个 `BEAT_AUDIO_STARTED` |

`turn_end` 的规则不变（thinking 且 queue 为空 → idle；speaking → 只设置标记）。
这样上面那个失败场景的流程是：ENDED(1) → thinking → turn_end → idle。

## 测试
- 原本失败的那个测试**不修改**，应该自然通过。
- 新增：最后一句 ENDED 之后（还没收到 turn_end）phase 为 thinking，subtitle 为 null；随后又收到一个新的 beat，`STARTED` → speaking。
- 其余测试全部保持通过。

## 完成标准
`pnpm test` 和 `pnpm typecheck` 全部通过；在 `docs/tasks/stage-1-report.md` 末尾追加「## 第二次修复记录」。
