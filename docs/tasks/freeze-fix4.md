# freeze-fix4 任务说明：桌面「按住说话」按下即被结束

> 来源：2026-10-28 正式录屏。用户也反馈过「说了没识别到」。执行者：Command Code（deepseek-v4-flash）。冻结期：只修这一个 bug。

## 铁律
冲突停下写进报告，不许绕过；Key 规则见 CLAUDE.md（D49）；**不准 commit**；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要打开任何图片；长命令显式 timeout；测试不发真实网络请求；**只准停自己启动的进程，禁止 `pkill -f vite` 这类宽匹配**；e2e 只跑 §3 指定的一个 spec。先写会失败的测试再改。

## §1 现象与根因（已核实）
- 服务端日志：按住说话那一轮没有任何 `turn_start`（客户端没发出录音）。
- `apps/client/src/live/Live.tsx` 桌面按钮 `data-testid="ptt"` 绑定了 `onPointerLeave={endPtt}`。按下后进入 listening，底栏出现「正在听」文字与声波，**按钮整体左移约 90px**（空闲 x≈918–1048 → 录音中 x≈830–960，视口 1440）。按在按钮中右部时，按钮移走 → 触发 pointerleave → 立刻 `pttUp`，录音 <300ms 被 `recorder.ts` 的 `MIN_RECORDING_MS` 丢弃。
- 窗口级 `pointerup` / `pointercancel` 监听（同文件）已经负责结束录音。

## §2 修法
1. 桌面 PTT 按钮：`onPointerDown` 时 `setPointerCapture(pointerId)`；**删除按钮上的 `onPointerLeave`**（结束只靠 pointerup / pointercancel，含窗口级监听）。手机端 `onPointerDown={startPtt}` 的那个按钮、录音面板「发送」按钮（`live-recording-send`）同样检查：若存在同类「布局变化导致 pointerleave 提前结束」的风险，按同样方式处理；行为写进报告。
2. 录音状态下桌面按钮位置不变：「正在听」与声波不得挤动 PTT 按钮（例如给它们预留固定宽度或改为绝对定位），只改 `live.css` / 对应 JSX 结构，不改视觉设计。

## §3 测试
- e2e（只跑这一个）：新增 `e2e/ptt-hold.spec.ts`（desktop 项目）：鼠标移到 PTT 按钮**右侧 80% 处**按下，按住 2s 再松开 → 断言进入过 listening 且 2s 内没有提前回到 idle / thinking；并断言按下前后 PTT 按钮 boundingBox 的 x 偏移 < 4px。用 `pnpm e2e -- e2e/ptt-hold.spec.ts --project=desktop`（显式 timeout 600000）。
- `pnpm test`、`pnpm typecheck` 全绿，`pnpm smoke` 通过。

## §4 报告
`docs/tasks/freeze-fix4-report.md`：改动、测试名、手机端两个按钮的检查结论。

## 关卡 1–5 结论（Claude 决定，修复）
1. YAGNI：只修 PTT 提前结束与按钮位移。
2. 端口/适配器：只动视图层（Live.tsx / live.css），不碰录音核心与协议。
3. 函数式核心：无新逻辑；结束条件收敛到 pointerup / pointercancel 一处。
4. 契约：按住期间无论布局怎样变，只有松手（或系统取消）才结束录音。
5. 测试奖杯：一个针对性的 e2e（真实指针事件 + 布局断言），单测不适合测这个。
