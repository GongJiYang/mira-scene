# S6b-fix3：fix2 验收后的 2 个问题

> s6b.md 铁律有效。不要打开图片；长命令显式传大 timeout，同一命令超时两次就停下报告。

## 1.【原则】error 全部跳过 turnId 过滤，破坏了 D3 与打断语义
- 现状：fix2 为让 `unknown_character` 送达，把 reducer 里**所有** `error` 都移到 turnId 过滤之前。但服务端还会发**轮次级**错误（`llm_timeout`、`turn_failed` 等，带具体 turnId）：打断一轮后，旧轮次迟到的 error 会把界面切进错误态，违反 D3「不属于本轮的消息一律丢弃」和 Q1 打断语义。
- 改法：错误要区分范围。
  - protocol：`error` payload 增加可选 `scope: "session" | "turn"`，缺省视为 `"turn"`（向后兼容）。
  - 服务端：会话级错误（`unknown_character`，以及 hello/会话阶段、额度上限这类与具体轮次无关的错误——逐个核对 `session.ts` 里所有 `emit("error")` / `type: "error"` 的位置，在报告里列表说明每个的归类）设 `scope: "session"`；其余保持轮次级。
  - 客户端 reducer：只有 `scope === "session"` 的 error 跳过 turnId 过滤；轮次级 error 回到 D3 过滤之后。`connection.ts` 等待期间放行 error 的逻辑同样只对会话级生效。
  - **恢复** fix2 删掉的那条断言「旧轮次的 error 被丢弃」，并新增「会话级 error 不按 turnId 过滤」。
- 测试：reducer 单测（两类 error 各自行为）；fast-check：任意 turnId ≠ 当前轮的轮次级 error 都不改变状态。

## 2. 杯柄里的棋盘格只清掉了一部分
- 现状：`assets/parts/fg_table_v.png` 清了 142 像素，但杯柄环内上半部分仍有棋盘格（Claude 看图确认）。原因：检测器要求「相邻格明暗相反」，环边缘被截断的半格识别不出来。
- 背景：这块区域是**杯柄环住的封闭区域**，不与图片边界连通，所以当初 `align.py` 的边界 flood fill 抠图漏掉了它。
- 改法：在 `checker.py` 加「封闭区域填充」模式：以已识别出的棋盘格像素为种子，在区域框 `(915,735)–(1000,805)` 内做 flood fill，扩展到相连的、灰白（R≈G≈B 容差 14）且亮度 ≥ 180 的像素，全部置为完全透明；杯柄本身（亮度更高的暖白瓷器、有明显色偏）不会被选中——用「R≈G≈B」排除。区域外逐字节不变（断言）。
- 自验：打印处理前后区域内的灰白像素数、透明像素数；处理后区域内剩余的灰白像素若仍连成 ≥ 20 像素的块，报告里列出坐标。

## 验收
`pnpm test`、`pnpm typecheck`、`pnpm e2e` 通过。报告追加到 `docs/tasks/s6b-report.md` 末尾「fix3」一节。Claude 会重新截图肉眼确认杯柄。
