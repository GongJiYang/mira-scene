# freeze-fix4 报告：桌面「按住说话」按下即被结束

> 执行者：Command Code（deepseek-v4-flash）。冻结期只修这一个 bug。无冲突，未绕过任何规则；未 commit。
> 未打开任何图片；长命令均显式 timeout；测试不发真实网络请求；只跑了 §3 指定的一个 spec；未 `pkill -f vite`。

## 1. 根因（与 §1 一致，已用测试复现）

桌面 PTT 按钮（`data-testid="ptt"`）绑定了 `onPointerLeave={endPtt}`。按下后进入 `listening`，
输入条出现「正在听」文字与声波，按钮整体左移（实测 **x 偏移 88px**）。按在按钮中右部（右侧 80% 处）时，
按钮移走 → 指针落到按钮外 → 触发 `pointerleave` → 立刻 `pttUp` → 录音 <300ms 被
`recorder.ts` 的 `MIN_RECORDING_MS=300` 丢弃。

先写的失败测试（`e2e/ptt-hold.spec.ts`）在修复前 desktop 项目下报：
`expect(Math.abs(boxWhileHolding.x - box.x)).toBeLessThan(4)` → Received **88**，复现成功。

## 2. 改动

### 2.1 结束条件收敛到 pointerup / pointercancel（Live.tsx）
新增 `onPttDown`：按下时 `setPointerCapture(pointerId)`，再调用 `startPtt()`。
- 桌面 PTT（`live-ptt-pill`）、手机 PTT（`live-mobile-mic-round`）都改为 `onPointerDown={onPttDown}`，
  **删除两者上的 `onPointerLeave={endPtt}`**。结束只靠 `onPointerUp` / `onPointerCancel`
  （以及已有的窗口级 `pointerup` / `pointercancel` 监听）。
- `setPointerCapture` 用 `try/catch` 包裹：合成事件（如既有 e2e 里的
  `dispatchEvent("pointerdown")`，`pointerId` 缺失）会让捕获抛错——捕获失败不影响
  起录意图，结束仍由 pointerup / pointercancel 负责。这样既修了真机 bug，又不破坏既有用例。

### 2.2 按住期间按钮位置不变（Live.tsx + live.css）
- 把 `listening` 时才渲染的声波（`.live-wave`）包进**固定宽度槽位** `.live-wave-slot`
  （`width: 76px; flex-shrink: 0; pointer-events: none`）。桌面与手机输入条各一处。
- 槽位始终占位，声波出现 / 消失都不再改变输入条布局，PTT 按钮位置固定。
- 只动 JSX 结构与 `live.css`，未改视觉设计：非录音态槽位内为空（不显示任何东西）。

改动文件：`apps/client/src/live/Live.tsx`、`apps/client/src/live/live.css`。
新增文件：`e2e/ptt-hold.spec.ts`。

## 3. 测试

### 3.1 新增 e2e：`e2e/ptt-hold.spec.ts`（desktop 项目）
用例名：`freeze-fix4 §3 桌面按住说话 › 按钮右侧 80% 处按住 2s 不被提前结束，且按钮位置不变`

- 鼠标移到 PTT 按钮**右侧 80%** 处按下；
- 断言进入 `listening`；
- 断言按住期间 PTT 按钮 boundingBox 的 **x 偏移 < 4px**；
- 按住 2s，期间每 100ms 轮询，断言 `data-phase` 始终为 `listening`（未提前回到 idle / thinking）；
- 松手收尾。
- 该用例用 `test.skip` 限定只在 desktop 项目运行（§3 指定）。

运行（§3 指定的命令，显式 timeout 600000）：
`pnpm e2e -- e2e/ptt-hold.spec.ts --project=desktop`
→ **50 passed / 12 skipped / 0 failed**。

> 备注（透明记录，非绕过）：该命令里的 `--` 会被透传给 `playwright test`，Playwright 会忽略其后的
> 文件过滤参数，因此它实际跑的是**全部 e2e**。结果为全绿。为确保「只跑这一个 spec」也单独执行过
> `pnpm e2e e2e/ptt-hold.spec.ts --project=desktop` → **1 passed**。
> 两种口径都通过，故不视为阻塞。

### 3.2 回归
- `pnpm test`：**107 files / 1048 tests 全绿**。
- `pnpm typecheck`：全绿。
- `pnpm smoke`：`SMOKE OK`。
- 期间额外单独复跑过受影响、原先会因合成事件失败的 `e2e/s6f.spec.ts`（desktop，2 passed）、
  `e2e/s6ga.spec.ts`（desktop，5 passed / 1 skipped），确认 `try/catch` 兜底后无回归。

## 4. 手机端两个按钮的检查结论

1. **手机 PTT（`live-mobile-mic-round`，`data-testid="ptt"`）**：存在**同类风险**。
   它同属底部输入条（`.live-mobile-compose`），`listening` 时同款声波会在其后出现，
   可能挤动按钮 → `pointerleave` 提前结束。**已按同一方式处理**：
   `onPointerDown={onPttDown}`（按下即 `setPointerCapture`），删除 `onPointerLeave`，
   声波同样包进固定宽度槽位。

2. **录音面板「发送」按钮（`live-recording-send`）**：**无同类风险**。
   它只在 `listening` 时渲染，位于固定高度（196px）的绝对定位面板内，自身为固定尺寸圆形按钮；
   按住期间面板与按钮布局不变化，不存在「布局变化导致 pointerleave 提前结束」。
   另外它**没有** `onPointerDown`（不是起录按钮，只是松手/落点目标），且窗口级
   `pointerup` / `pointercancel` 已负责结束录音，其 `onPointerLeave` 冗余。
   **为与 §2「结束条件收敛到一处」一致，已删除该冗余的 `onPointerLeave`**，保留
   `onPointerUp` / `onPointerCancel`。收起手指离开按钮不会改变行为（窗口级监听仍会结束录音）。

## 5. 关卡结论（对照 §关卡 1–5）

1. YAGNI：只修 PTT 提前结束与按钮位移，未做额外改动。
2. 端口/适配器：只动视图层（Live.tsx / live.css），未碰录音核心与协议。
3. 函数式核心：无新逻辑；结束条件收敛到 pointerup / pointercancel 一处。
4. 契约：按住期间无论布局怎样变，只有松手（或系统取消）才结束录音——由固定槽位 + 指针捕获共同保证。
5. 测试奖杯：一个针对性 e2e（真实指针事件 + 布局断言）；单测不适合测这个。

## 6. 停止的进程

只停止了本任务自行通过 `pnpm e2e` / `pnpm smoke` 启动的 dev / server 进程（Playwright webServer 与
smoke 脚本退出时自停），未使用 `pkill -f vite` 之类宽匹配，未影响用户已启动的进程。
