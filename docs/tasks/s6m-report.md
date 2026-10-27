# S6m 报告：动作表面板 + 新动作（含物理后覆盖）

执行：Command Code（deepseek-v4-flash），分支 `s6m`（合并 S6l-fix2 的 main 上做）。
铁律遵守：**未 commit**；**未运行 e2e**（仅编写）；未打开任何图片；未碰 `tools/live2d-pipeline/**`、`skills/**`；
长命令显式传大 timeout；测试里不发真实网络请求。先写会失败的测试再改代码。

---

## 一、改动文件

| 文件 | 改动 |
|---|---|
| `packages/protocol/src/messages.ts` | §0：`turn_end.reason` 枚举加 `"throttled"` |
| `apps/server/src/session.ts` | §0：poke / gift 被限流时回无 beat 的 `turn_end{reason:"throttled"}` |
| `apps/client/src/state/reducer.ts` | §0：无改动（既有「thinking + 空 queue → idle」已覆盖）；仅加测试固化 |
| `apps/client/src/render/live2d/postPhysics.ts` | §1：**新增** 物理后覆盖纯函数（混合公式 + 渐入 / 渐出） |
| `apps/client/src/render/live2d/localActions.ts` | §2：**新增** 四个新动作的纯函数曲线 |
| `apps/client/src/render/live2d/cubism/yunaRenderer.ts` | §1：物理 `evaluate` 与 `update` 之间加覆盖阶段；从模型读参数范围；`YunaFrame.postPhysics` |
| `apps/client/src/types/cubism-shim.d.ts` | §1：shim 补 `getParameterIndex / Min / Max / ValueByIndex / setParameterValueByIndex` |
| `apps/client/src/live/previewStore.ts` | §3：**新增** 预览 store + `composePreview` 纯函数 |
| `apps/client/src/live/ActionPanel.tsx` | §3：**新增** 动作表面板（桌面标签 + 手机抽屉 + 按钮网格） |
| `apps/client/src/live/StageRenderer.tsx` | §3：渲染时合成预览（情绪 / 表情 / 动作），phase 变化即结束预览 |
| `apps/client/src/live/Live.tsx` | §3：桌面弹幕窗口顶部挂载面板；手机 `MobileMenu` 传 `phase` |
| `apps/client/src/live/entries.tsx` | §3：手机菜单加「动作表」项 + 底部抽屉 |
| `apps/client/src/live/uiText.ts` | §3：新增动作表文案与 `ACTION_LABELS` |
| `apps/client/src/live/live.css` | §3：动作表面板样式（只求清楚可用） |
| `apps/client/test/postPhysics.test.ts` | §1：**新增** |
| `apps/client/test/localActions.test.ts` | §2：**新增**（含 fast-check 属性测试） |
| `apps/client/test/composePreview.test.ts` | §3：**新增**（含 `previewDisabled`） |
| `apps/client/test/previewNoSend.test.ts` | §4：**新增**（预览不发网络集成） |
| `apps/client/test/reducer.test.ts` | §0：加 throttled turn_end 用例 |
| `apps/server/test/pokeGift.integration.test.ts` | §0：加限流回 throttled 的集成用例 |
| `e2e/s6m.spec.ts` | §4：**新增**（只写不跑） |
| `docs/tasks/s6m-report.md` | §5：本报告 |

---

## 二、每条需求 → 测试名

### §0 被限流的 poke / gift 不再卡「思考」
- 集成 `apps/server/test/pokeGift.integration.test.ts` → describe「S6m §0：限流的 poke / gift 回 turn_end{throttled}」：
  - `3 秒内第二次 poke：收到 turn_end{reason:'throttled'}，且无 beat`
  - `礼物冷却内的第二次 gift 同样回 throttled`
  - `被限流的一轮不扣轮数：第二次 throttled 后仍能正常起新轮（无 quota 错误）`
- 客户端 reducer `apps/client/test/reducer.test.ts` → `S6m §0：thinking + 无 beat 的 throttled turn_end → 立即回 idle（不卡思考）`

### §1 物理后覆盖
- `apps/client/test/postPhysics.test.ts`：
  - `postPhysicsWeight 渐入 / 渐出`（端点 0、0.25s 渐入、0.35s 渐出、越界 0）
  - `postPhysicsParams 不影响现有参数（无动作时）`（`action=null` → 空目标 + 权重 0）
  - `混合公式 value = phys*(1-w) + target*w`（`w=0.5 → 0.75`；`w=0/1` 端点）
- 外壳读模型范围、写入前截断：`yunaRenderer.ts` 的 `applyPostPhysics`（运行时读 `getParameterMinimumValue/MaximumValue`，不硬编码；未知 id `pushEvent` 记一次并去重）。原型验证见下方「模型范围实测」。

### §2 新动作（参数法）
- `apps/client/test/localActions.test.ts`：
  - `新动作时长符合表`（wave 2.0 / tail_wag 2.5 / ear_flick 0.8 / sway 2.5）
  - `越界时间（负 / 时长及以后）不写任何参数` + `起止权重为 0`
  - `wave：中途 ParamHandR 抬起、ParamHandTurnR 摆幅 ≤ 60% 范围`
  - `tail_wag：三节相位差，幅度 ≤ 70% 范围`
  - `ear_flick：弹动冲高再回，两次（0.15s 内冲高）`
  - `sway：写物理输入 ParamBodyAngleZ / ParamAngleZ，且在 ±6 / ±4 内并已经 clampParam`
  - 属性测试（fast-check）：`任意动作 × 任意时刻：postPhysics / input 值都在替身范围，且不含水印参数`

### §3 动作表面板
- `apps/client/test/composePreview.test.ts`：
  - `previewDisabled`（thinking / speaking 禁用）
  - `previewDurationSec`（情绪 3s、表情 2s、动作按各自时长）
  - `composePreview`：预览覆盖（情绪 / 表情 / 动作）、到期恢复、sway 给物理输入、speaking 拒绝、不改 `base.visual`
- 面板禁用逻辑由 `previewDisabled` 纯函数覆盖；按钮 `disabled={previewDisabled(phase)}`，禁用时显示「她在说话」。
- 面板 UI（桌面标签 / 手机抽屉 / 分组按钮）由 e2e 覆盖（项目无 RTL）。

### §4 测试
- 集成 `apps/client/test/previewNoSend.test.ts`：`点击各类预览项：connection.send* 均未被调用`；`预览不改 reducer 的 visual 与 currentTurnId`。
- e2e `e2e/s6m.spec.ts`：「打开动作表 → 点挥手 → 仍是 idle → 截图」，testid `action-panel` / `action-toggle` / `action-wave`。**只写不跑**。
- `pnpm test` / `pnpm typecheck` 全绿；`PROVIDER_MODE=mock pnpm smoke` 通过（详见下方「验证」）。

---

## 三、模型里实际读到的手 / 尾 / 耳参数范围（数值）

来源：解析 `apps/client/public/models/yuna/yuna.moc3`（id 表 section @94984 共 185 参数，范围表 @2685248，每条 `[min, max, default]` float32）。
运行时外壳用 Cubism 的 `getParameterMinimumValue / getParameterMaximumValue` 读同一份范围（不硬编码）。

| 参数 | min | max | default |
|---|---|---|---|
| `ParamHandR` / `ParamHandL` | -1 | 1 | 0 |
| `ParamHandTurnR` / `ParamHandTurnL` | -1 | 1 | 0 |
| `ParamHandHoldR` / `ParamHandHoldL` | -1 | 1 | 0 |
| `ParamTailX1` / `ParamTailX2` / `ParamTailX3` | -1 | 1 | 0 |
| `ParamTailY1` | -1 | 1 | 0 |
| `ParamParamTailY2` | -1 | 1 | 0 |
| `ParamEarsLX1` / `ParamEarsLX2` / `ParamEarsLY` / `ParamEarsLY2` | -1 | 1 | 0 |
| `ParamEarsRX1` / `ParamEarsRX2` / `ParamEarsRY1` / `ParamEarsRY2` | -1 | 1 | 0 |

物理**输入**（sway 用）：`ParamAngleX/Y/Z`、`ParamBodyAngleX/Y/Z` 均为 **[-30, 30]**，默认 0。

> 结论：wave / tail_wag / ear_flick 写的手 / 尾 / 耳都在 [-1, 1]；sway 写的 `ParamBodyAngleZ`（±6）/ `ParamAngleZ`（±4）经 `clampParam` 后落在 `COMFORT_RANGES`（[-10,10] / [-30,30]）内，再交由物理带动头发 / 耳朵 / 尾巴。

---

## 四、验证

- `pnpm test`：**94 文件 / 922 测试全通过**。
- `pnpm typecheck`：5 个 workspace 全绿。
- `PROVIDER_MODE=mock pnpm smoke`：**SMOKE OK**（总耗时 3231ms）。
- 未运行 `pnpm e2e`（按铁律）。e2e 用例已编写于 `e2e/s6m.spec.ts`。

---

## 五、未决歧义 / 取舍

1. **预览与 reducer 解耦**：预览完全走 `usePreviewStore`（独立 zustand slice），`composePreview` 只在渲染时合成，**不改** `useStageStore.visual`。这样 A 状态机与剧情层完全不受影响；代价是预览状态不在 reducer 里，刷新即丢（符合「本地预览」语义）。
2. **情绪预览含 `surprised`**：面板按任务列出 6 个情绪，但忧奈模型只有 5 套组合（`surprised` 无对应 → 经 `toYunaEmotion` 映射为 `calm`）。按钮保留，行为与既有 `emotionMap` 一致。
3. **动作表的「现有动作」预览**：`drink / glance / phone / show_item` 复用 `yunaParams` 的 `silentAction` 通路（预览项驱动 `silentAction`，不改 `activeAction`）；新动作走本地曲线 + 物理后覆盖。两者在 `StageRenderer.frame` 里按 `effectiveSilentAction` 合并。
4. **`postPhysics` 未知参数上报**：每帧发现未知 id 会 `pushEvent`，用 `Set` 去重避免刷屏；测试替身不覆盖该路径（属外壳副作用），未单测。
5. **文案措辞**：`uiText.ts` 的中文名（平静 / 防备 / … / 挥手 / 摇尾巴 / 抖耳朵 / 身体晃）按任务表措辞落定，用户可再改。
6. **sway 的物理后覆盖为空**：sway 只写物理**输入**，其「后覆盖」目标为空（`postPhysicsParams("sway", …)` 返回空目标），符合「让物理带动头发 / 耳朵 / 尾巴」的设计。
