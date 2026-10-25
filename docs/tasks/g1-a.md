# G1-a 任务说明：S2 遗留修复 + 协议更新 + Mock 剧本改为「凛」

你是执行工程师。基线提交 `874011f`。**不要 commit，不要改 `docs/architecture/`。**
只读背景：`docs/architecture/decisions.md`（重点 D25、D27、D28、D29，以及第 6 轮的 D8 复核）、`docs/architecture/quality-scenarios.md`（Q 编号）、`docs/tasks/stage-2-fix.md`、`docs/tasks/stage-2-report.md`。

## 铁律
1. 说明和验收测试冲突时，停下来写进报告，不得为了让测试通过而改测试的意图。
2. **不许改，也不许绕过。** 凡是本文没有授权修改的模块，都不能改，也不能通过别的方式绕过它（比如在 reducer 之外直接 setState）。确实需要改时，写进报告并说明理由，不要自己动手。
3. `pnpm dev` 在没有 `.env` 的情况下必须完整可用（Q10）。

## 本次授权修改的范围
- `packages/protocol/`：按 §2 修改。
- `apps/client/src/state/`：只限 `stage-2-fix.md` 的两条规则，以及 §2 带来的字段重命名。
- `apps/client/src/core/`、`apps/server/`：跟随协议变化做必要的修改，再加上 §1 和 §3。
- 测试：**只允许**因为枚举值或字段重命名而修改断言里的字面值（例如 `"hold_cup"` 改成 `"cup"`），断言的意图不能变。每改一处都在报告里列出。

## 1. S2 遗留修复
完整执行 `docs/tasks/stage-2-fix.md`（这份说明之前没有执行过）。两项内容：恢复会话时 turnId 同步改为在 reducer 内完成；新增 `INPUT_CANCELLED`，解决短按或麦克风失败后卡在 thinking 的问题。验收标准以那份文件为准。

## 2. 协议更新（`packages/protocol`）
### 2.1 枚举
| 名称 | 新取值 | 变化 |
|---|---|---|
| Emotion | neutral, calm, guarded, sad, warm, surprised | 不变 |
| **Hands**（原 Pose，**字段名 `pose` 一律改为 `hands`**） | cup, polaroid, camera, phone | 手部图层（D28） |
| Action | sip_coffee, glance_window, check_phone, show_polaroid | 换成凛的动作（D29） |
| Camera | wide, close_up | 不变 |
| Fx | rain_heavy, rain_stop, lights_dim, warm_glow | 不变 |
| StoryNode | arrive, probe, reveal, ending | 不变 |
| MediaType | **photo**, video | `image` 改为 `photo`（拍立得） |

`parseBeatLenient` 的降级值：非法的 hands 降级为 `cup`。

### 2.2 新增 `LlmBeat`（契约 ①，LLM 原始输出，本批只定义 schema，暂时不接入流水线）
| 字段 | 类型 |
|---|---|
| say | string |
| emotion | Emotion |
| suggest | Action \| null（可选） |
| advance | StoryNode \| null（可选） |

再加一个 `parseLlmBeatLenient(input: unknown): { llmBeat, warnings }`，**永不抛错**。规则：非法的 emotion 降级为 neutral；非法的 suggest 和 advance 降级为 null；say 缺失时降级为空串；输入不是对象时返回 neutral 的空 beat。配上测试。

### 2.3 新增消息（D27、D8 复核）
服务端 → 客户端：
| type | payload | 说明 |
|---|---|---|
| `media_ready` | `{ storyEventId: string, media: {type, id, url?: string}, status: "ready" \| "fallback" }` | 剧情层消息：**客户端不按 turnId 过滤**（本批只定义 schema，并在 reducer 里原样忽略，C 状态机放到 G1-c） |
| `pong` | `{}` | 心跳回复 |

客户端 → 服务端：
| type | payload |
|---|---|
| `ping` | `{}` |

本批**只定义 schema 并补测试**，心跳逻辑放到 G1-c。

### 2.4 SceneState
`pose` 改名为 `hands`。

## 3. Mock 剧本改为「凛」（D25）
角色设定：夏凛，27 岁，深夜电台《雨声信箱》的主持人。暴雨后的深夜，快打烊的咖啡馆里，她在等一位给电台写了三年信、从没露过面的听众（对方约好今晚来）。桌上有一杯她替对方点的咖啡，一直没人动，已经凉了。她随身带着拍立得。说话温和、慢，善于倾听，不轻易谈起自己。

- **只改 MockLLM 的台词和触发条件，流程逻辑保持不变**（意图识别、剧情推进规则不变）。
- 意图关键词补充：`ask_waiting`（等 / 谁 / 为什么 / 约），`ask_photo`（照片 / 拍立得 / 相机 / 拍），`ask_radio`（电台 / 节目 / 主持 / 声音），`comfort`，`greeting`，`other`。
- 进入 reveal 的那一轮，必须有一个 beat 带上：`media: {type:"photo", id:"photo_letters"}`、`camera:"close_up"`、`fx:"rain_stop"`、`emotion:"sad"`、`action:"show_polaroid"`、`hands:"polaroid"`。
- 至少一个 beat 带 `action:"glance_window"`，并且 `say` 为空串（无声动作）。
- 每个剧情节点、每种意图至少一组台词，中文，符合人设：不直接说出在等谁，靠细节暗示（那杯凉掉的咖啡、信、窗外的雨）。
- 占位 UI 和日志里出现的角色名「Mira」改为「凛」。**包名 `@mira/*` 和仓库名不要改。**

## 4. 完成标准
- `pnpm install`、`pnpm test`、`pnpm typecheck`、`pnpm smoke` 全部通过。
- 写 `docs/tasks/g1-a-report.md`，包括：改动文件清单；**因重命名而修改的测试断言逐条列表**；新增的测试；`stage-2-fix.md` 的验收结果，附上 grep 结果，证明 connection.ts 已不再直接 setState 修改 reducer 管理的字段；你发现的歧义或矛盾。
