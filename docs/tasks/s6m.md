# S6m 任务说明：动作表面板 + 新动作（含物理后覆盖）

> 来源：D48 第 3 项（用户 2026-10-28 要求：主界面可收起的「动作表」，点一下她就做；新动作只做参数法一版，不需要 A/B 对比）。关卡 1–5 由 Claude 决定（用户授权）。执行者：Command Code（deepseek-v4-flash）。在合并了 S6l-fix2 的 main 上做。§0 是 Claude 审 S6l-fix2 时发现的一个小问题，顺带修。

## 铁律
冲突停下写进报告；Key 规则见 CLAUDE.md（D49）；不准 commit；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片；长命令显式传大 timeout，同一命令超时两次就停下写进报告；测试里不发真实网络请求；**不要运行 e2e**（可以写，不运行，报告注明）。不改台词。样式只求清楚可用（S6u 统一重做）。先写会失败的测试再改代码。

## 已核实的事实（Claude）
- `apps/client/public/models/yuna/yuna.physics3.json`：物理**输入**只有 `ParamAngleX/Y/Z`、`ParamBodyAngleX/Y/Z`（及 X2/Y2/Z5）、`ParamBrowL/R`、`ParamEyeL/ROpen`；**手（`ParamHandL/R`、`ParamHandHoldL/R`、`ParamHandTurnL/R`）、尾巴（`ParamTailX1–3`、`ParamTailY1`、`ParamParamTailY2`）、耳朵（`ParamEars*`）全部是物理输出**——在物理之前写会被覆盖（S6g-A 删耳朵动作就是这个原因，D46③「物理后覆盖」当时推迟）。
- 现有动作 `drink/glance/phone/show_item` 在 `apps/client/src/render/live2d/yunaParams.ts` 的 `SILENT_ACTION_TABLE`，经 `StageRenderer.tsx` 的 silentAction 驱动。

## §0 被限流的 poke / gift 让客户端卡在「思考」（先修）
- 现状（Claude 审 S6l-fix2 时发现）：`apps/server/src/session.ts` 对 poke / gift 限流时只记 `input_throttled` 后 `return`，不发任何下行；而客户端发出 poke / gift 时已经 `beginTurn` 进入 thinking，等不到 `turn_end` 就一直卡着。两端冷却相同，但网络延迟会让服务端看到的间隔略短，这种情况真实会发生。
- 修法：被限流时仍回 `turn_end`，`reason: "throttled"`（协议 zod 同步加枚举值），不发 beat、不扣轮数；客户端收到无 beat 的 turn_end 按现有规则回 idle。
- 测试：集成——3 秒内连发两次 poke → 第二次收到 `turn_end{reason:"throttled"}`、轮数不增加；客户端 reducer：thinking + 无 beat 的 throttled turn_end → idle。

## §1 物理后覆盖（D46③）
- 在 Live2D 渲染外壳里，**物理更新之后、模型 update 之前**加一个覆盖阶段：`postPhysicsParams(input) → Record<string, number>`（纯函数）给出的参数按权重混合写入：`value = physicsValue * (1 - w) + target * w`，`w` 由动作的渐入 / 渐出曲线决定（0.25s 渐入、0.35s 渐出）。
- 参数范围在运行时从模型读取（Cubism 的 parameter min/max），写入前截断；不要硬编码范围。读不到的参数 id 跳过并 `pushEvent` 记一次。
- 不影响现有任何参数（没有动作时 `postPhysicsParams` 返回空对象）。

## §2 新动作（参数法，一版）
新增动作 id（客户端本地动作，不进协议、不给 LLM）：
| id | 名称 | 写入 | 时长 |
|---|---|---|---|
| `wave` | 挥手 | 物理后覆盖：`ParamHandR` 抬到上限附近，`ParamHandTurnR` 以 ~2.5Hz 正弦摆动（幅度取范围的 60%） | 2.0s |
| `tail_wag` | 摇尾巴 | 物理后覆盖：`ParamTailX1/X2/X3` 依次相位差 0.15 的正弦（~1.8Hz，幅度 70%） | 2.5s |
| `ear_flick` | 抖耳朵 | 物理后覆盖：`ParamEarsLY2`、`ParamEarsRY2` 快速两次弹动（各 0.15s 冲到上限再回） | 0.8s |
| `sway` | 身体晃 | 物理**输入**：`ParamBodyAngleZ` ±6 度、`ParamAngleZ` ±4 度，~0.8Hz 正弦（经现有 `clampParam`），让物理带动头发 / 耳朵 / 尾巴 | 2.5s |
- 曲线写成纯函数（输入：动作 id、已进行秒数；输出：参数目标 + 权重），放 `render/live2d/localActions.ts`。

## §3 动作表面板
- 列出（分组，按钮即可）：
  - 情绪 6：calm 平静、guarded 防备、sad 难过、warm 温暖、surprised 惊讶、neutral 中性
  - 表情 10：love 爱心眼、heart 飘爱心、shy 脸红、amazed 惊讶、cry 哭、angry 生气、black 脸黑、dark 黑眼圈、fly_head 飞头、fly_pet 飞宠
  - 动作 4（现有）：drink 喝一口、glance 瞄弹幕、phone 看手机、show_item 抱熊
  - 新动作 4：wave 挥手、tail_wag 摇尾巴、ear_flick 抖耳朵、sway 身体晃
- 点一下 = **只在本地预览**：情绪保持 3s 后恢复；表情按 accent 规则渐入、保持 2s、渐出；动作按其时长。**不发服务端、不算一轮、不影响剧情和导演层冷却。**
- 忧奈在 `thinking` / `speaking` 时整组按钮禁用（显示「她在说话」）；预览进行中如果来了新一轮输入或 beat，立即结束预览（渐出）。
- 位置：桌面在弹幕窗口顶部做一个可展开的「动作表」标签（默认收起）；手机放进右上角菜单里的「动作表」项，点开为底部抽屉。
- 实现上：预览是客户端独立状态（`previewStore`），渲染时与正常视觉合成：预览优先于当前待机视觉，但不改 reducer 里的 `visual`。纯函数 `composePreview(visual, preview, now)`。

## §4 测试
- 单测：`postPhysicsParams` 混合公式与渐入渐出；四个新动作曲线（起止为 0、峰值在范围内、时长正确）；`composePreview`（预览覆盖、到期恢复、speaking 时拒绝）；面板禁用逻辑。
- 属性测试（沿用 yunaParams 的 fast-check 写法）：任意动作 × 任意时刻，写入值都在模型范围内（用测试替身提供 min/max），`Param1`–`Param10` 恒为 0。
- 集成：点击预览不会产生任何 WebSocket 发送（断言 `connection.send*` 未被调用）。
- e2e：写一条「打开动作表 → 点挥手 → 截图」，**不运行**。
- `pnpm test`、`pnpm typecheck` 全绿；`PROVIDER_MODE=mock pnpm smoke` 通过。

## §5 报告 `docs/tasks/s6m-report.md`
改动文件、每条 → 测试名、模型里实际读到的手 / 尾 / 耳参数范围（数值）、未决歧义。

## 关卡 1–5 结论（Claude 决定）
1. **YAGNI**：面板只做预览，不做录制 / 编排；新动作只做参数法；不把新动作开放给 LLM（以后要用再加协议）。
2. **端口/适配器**：纯客户端，不碰服务端和外部服务。
3. **函数式核心**：`postPhysicsParams`、`localActions` 曲线、`composePreview` 纯函数；外壳只负责在物理之后写参数和读模型范围。
4. **契约式设计**：物理后覆盖写入前必按模型范围截断；预览不改 reducer 状态、不发网络；说话中禁用；水印参数恒为 0。
5. **测试奖杯**：纯函数单测 + 属性测试 + 「预览不发网络」集成测试；e2e 只写不跑。
