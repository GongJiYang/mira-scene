# freeze-fix3 报告：截图生成期间的「边翻边聊」铺垫

> 执行者：Command Code（deepseek-v4-flash）。日期：2026-10-28。分支 `freeze-fix3`（未 commit）。

## 结论

§1–§4 全部落地。`pnpm test`（107 文件 / 1048 用例）、`pnpm typecheck`、`pnpm smoke` 全绿。未跑 e2e，未发真实网络请求，未打开图片，未 commit。

## §1 客户端：铺垫调度

- 触发：剧情照片（`type: "photo"`）`developing`（加载中）+ A `idle`。
- 首次距 idle 1.5s、之后每 10s、每个截图事件最多 3 次；就绪 / 失败 / 用户开口即停。
- 不受 `state/nudge.ts` 频率限制约束、也不计入其计数（走独立的 `recordPhotoWaitingNudge`，直接 `dispatch(NUDGE)` + `sendNudge()`）。

产物：
- `apps/client/src/state/photoWaiting.ts` — 纯函数 `photoWaitingDecision(input)`（常数 `PHOTO_WAITING_FIRST_MS=1500` / `PHOTO_WAITING_INTERVAL_MS=10000` / `PHOTO_WAITING_MAX=3`）。
- `apps/client/src/core/photoWaiting.ts` — `createPhotoWaitingScheduler`（可注入时间线 / 时钟 / 观察面，可单测）+ `installPhotoWaiting`（浏览器接线：订阅 C 照片槽位与 A phase，用统一时间线 `photo-waiting:<storyEventId>` key 排期）。
- `apps/client/src/core/controller.ts` — 新增 `recordPhotoWaitingNudge`，`bootstrapConnection` 里 `installPhotoWaiting`。

| 契约 | 测试名 |
| --- | --- |
| 首次 1.5s | `photoWaiting.test.ts > idle 后满 1.5s、截图仍在加载：发第一次`；`photoWaitingShell.test.ts > idle + 截图 developing：首次在 1.5s 后铺垫` |
| 间隔 10s | `photoWaiting.test.ts > 第一次之后，距上次满 10s：发`（及不足 10s 不发） |
| 上限 3 | `photoWaiting.test.ts > 已铺垫 3 次：即使满足时间也不再发（上限）`；`photoWaitingShell.test.ts > 之后每隔 10s 再插一次，每个截图事件最多 3 次` |
| 就绪即停 | `photoWaiting.test.ts > 截图就绪（ready / shown）：不发`；`photoWaitingShell.test.ts > 截图就绪（离开 developing）：立即停止剩余计划` |
| 失败即停 | `photoWaiting.test.ts > 截图失败走兜底（fallback）：不发` |
| 非 idle 不发 | `photoWaiting.test.ts > A 不是 idle…：不发`；`photoWaitingShell.test.ts > A 不是 idle 时不发` |

## §2 服务端：铺垫轮提示词

- 纯函数 `hasWaitingPhoto({ scheduled, ready, failed? })`：有「已调度、未就绪」的照片即 true。
- `runTurn`：nudge 轮且仍有未就绪照片 → `scene_notes` 追加角色包 `photoWaitingNote`（代码只读字段，不写死文案）。
- 会话新增 `photoScheduled`（调度照片时登记，就绪 / 失败时删除）与 `photoWaitingFired`（铺垫计数，供 Mock 取词）。

产物：
- `apps/server/src/scene/waitingPhoto.ts` — `hasWaitingPhoto`。
- `apps/server/src/session.ts` — 登记 / 清除照片等待集；`runTurn` 注入 `photoWaitingNote`，向 LLM 上下文传 `photoWaiting` / `photoWaitingIndex`。
- `apps/server/src/ports.ts` — `LLMContext` 新增 `photoWaiting?` / `photoWaitingIndex?`。
- `characters/yuna/content.json` — 新增 `photoWaitingNote`（照抄任务给定文案）。

| 契约 | 测试名 |
| --- | --- |
| 未就绪判定（纯函数） | `waitingPhoto.test.ts`（5 例：未就绪 / 全就绪 / 失败 / 部分 / 无调度） |
| reveal 后就绪前 nudge → 含 note | `photoWaiting.integration.test.ts > reveal 尚未就绪 → nudge 提示词含 photoWaitingNote；就绪后再 nudge → 不含` |
| 普通轮不含 note | `photoWaiting.integration.test.ts > 普通轮（非 nudge）不追加 photoWaitingNote` |

集成测试用假媒体端口（可控延迟就绪），就绪后等 `media_ready` 送达再发 nudge 验证 note 消失。发出真实网络请求：无。

## §3 Mock 模式

- nudge 轮 + 有未就绪照片 → 从 `pack.photoWaitingLines` 按 `photoWaitingIndex` 循环取一句；无预录语音时走现有 Mock TTS「占位音 + 字幕」路径（不报错）。

产物：
- `apps/server/src/adapters/mock/mockLlm.ts` — `composeBeats` 的 nudge 分支优先取 `photoWaitingLines`。
- `characters/yuna/content.json` — 新增 `photoWaitingLines`（照抄任务给定三句）。

| 契约 | 测试名 |
| --- | --- |
| 台词来自 photoWaitingLines | `mockPhotoWaiting.test.ts > nudge + 有未就绪照片：说 photoWaitingLines 里的一句` |
| 无未就绪时不取该表 | `mockPhotoWaiting.test.ts > nudge 无未就绪照片：回退到节点 hook（不是 photoWaitingLines）` |
| 按次序循环 | `mockPhotoWaiting.test.ts > 台词按次序循环取（同一 nudge + 未就绪多轮）` |

无预录语音不报错由现有 `mockTts` 契约保证（未命中 → 占位音 + `voice_fallback` 日志），未改。

## §4 验证

- `pnpm test`：107 文件 / 1048 用例全绿（本批新增 5 个测试文件、25 个用例）。
- `pnpm typecheck`：5 个 workspace 全绿。
- `pnpm smoke`：`SMOKE OK`。
- 未跑 e2e（按铁律）。

## 改动文件清单

新增：
- `apps/client/src/state/photoWaiting.ts`
- `apps/client/src/core/photoWaiting.ts`
- `apps/client/test/photoWaiting.test.ts`
- `apps/client/test/photoWaitingShell.test.ts`
- `apps/server/src/scene/waitingPhoto.ts`
- `apps/server/test/waitingPhoto.test.ts`
- `apps/server/test/mockPhotoWaiting.test.ts`
- `apps/server/test/photoWaiting.integration.test.ts`

修改：
- `apps/client/src/core/controller.ts`（`recordPhotoWaitingNudge` + 接线）
- `apps/server/src/session.ts`（等待集登记 + note 注入）
- `apps/server/src/ports.ts`（`LLMContext` 新字段）
- `apps/server/src/characters/pack.ts`（schema / Pack 新字段 `photoWaitingNote` / `photoWaitingLines`）
- `apps/server/src/adapters/mock/mockLlm.ts`（nudge 分支取 `photoWaitingLines`）
- `characters/yuna/content.json`（两个新字段，照抄任务给定文案）

## 未决歧义

1. **「每个截图事件最多 3 次」的边界**：客户端调度器按「进入 `developing` 的照片事件」计数；同一事件就绪后再来一张新照片会重新计数（新 storyEventId）。这是按 storyEventId 的口径，符合契约。
2. **就绪 / 失败后计数清理**：`photoWaitingFired`（服务端 Mock 取词索引）在图片就绪 / 失败时不重置，只在同一会话内单调递增；因 `photoWaitingLines` 是循环取词，且「未就绪」判定会拦住就绪后的取词，故不重置也无副作用。若要求「新一轮截图从第一句重新开始」，可改为在 `photoScheduled` 清空时归零——目前未做（YAGNI，且无可见差异）。
3. **客户端铺垫 nudge 与普通 nudge 的交互**：截图等待期的铺垫与 `state/nudge.ts` 完全独立（§1 明确），二者可能在短时间内各发一次；按契约不互相约束。未加额外的合成限流。
4. **`photoWaitingNote` 追加位置**：追加在 `scene_notes` 末尾（在换背景一次性提示 / poke 说明之后）。若同轮既有换背景 note 又有照片等待，两者会叠加；按现有 `scene_notes` 拼接风格处理。
