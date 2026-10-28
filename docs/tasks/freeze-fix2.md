# freeze-fix2 任务说明：录屏前两个 bug

> 来源：2026-10-28 freeze-fix1 合并后的真实模式验收录制（`e2e/out/acceptance/`）。执行者：Command Code（deepseek-v4-flash）。冻结期：**只修 bug，不加功能**。

## 铁律
冲突停下写进报告，不许绕过；Key 规则见 CLAUDE.md（D49），任何 Key 不得打印；**不准 commit**；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要打开任何图片；长命令显式传大 timeout；测试里不发真实网络请求；不改台词；**只准停自己启动的进程，禁止 `pkill -f vite` 这类宽匹配**；本批不跑 e2e。每条先写会失败的测试再改。

## §1 换背景关键词误触发（中）
- 现象：真实模式弹幕「嗯，去睡吧」启动了换背景任务（日志 `scene_prompt_version`，界面「正在换背景…」）。
- 根因：`characters/yuna/content.json` 的 `sceneTriggers` 里 `去.{0,6}(吧|呀|看看)` 太宽。
- 修法：只改 `sceneTriggers` 正则（JS 正则，可用否定前瞻），不改 `detect.ts` 的接口。
- 契约（表驱动单测，放在现有 scene 检测测试旁，用真实 `content.json` 编译出的正则）：
  - 必须命中：`带我去海边吧`、`换个背景`、`背景换成雪山`、`我们去海边吧`、`一起去游乐园吧`、`去海边看看`、`想看你在樱花树下`、`换个地方聊`。
  - 必须不命中：`嗯，去睡吧`、`去睡觉吧`、`早点去休息吧`、`快去吃饭吧`、`去洗澡吧`、`你去忙吧`、`我去倒杯水`、`去吧`、`那你去吧`。
- 现有换背景相关测试必须仍然通过。

## §2 `?fail=` 在恢复会话时不生效（中）
- 现象：已有会话的页面改用 `/?fail=tts` 打开，客户端 hello 带了 `resumeSessionId` 和 `faults:["tts"]`，服务端直接恢复旧会话（`session_resumed`），旧会话的 faults 为空，故障没注入。
- 修法：新增纯函数 `shouldResume(existing: readonly Fault[], requested: readonly Fault[]): boolean`——两者按集合相等（与顺序、重复无关）才恢复；`requested` 用 `parseFaults(hello.faults ?? deps.defaultFaults)` 解析后再比。不相等 → 按新会话处理（走现有 session_created 路径），并记日志 `resume_skipped { reason: "faults_changed" }`（不含 Key）。
- 不得影响 `ws_drop` 演示：同一页面断线重连时 faults 相同，仍须恢复。
- 测试：`shouldResume` 单测（相同 / 顺序不同 / 新增 / 清空）；集成测试——先建会话（无 faults），再用同一 `resumeSessionId` + `faults:["tts"]` 发 hello → 新会话且 `faults` 含 tts；再用相同 faults 重连 → 恢复。

## §3 验收
- `pnpm test`、`pnpm typecheck` 全绿；`pnpm smoke` 通过。
- 报告 `docs/tasks/freeze-fix2-report.md`：每条 → 测试名；§1 最终正则原文；未决歧义。

## 关卡 1–5 结论（Claude 决定，均为修复）
1. **YAGNI**：只修这两条；结局视频（真实模式下 video 被送去生图）用户决定后续再议，不在本批；runner 超时竞态只影响日志，不修。
2. **端口/适配器**：§1 只改角色包内容；§2 在 session 的 hello 外壳。
3. **函数式核心**：`shouldResume` 纯函数；关键词判定沿用 `detectSceneRequest`。
4. **契约式设计**：faults 集合相等才恢复；关键词以正反例表为契约。
5. **测试奖杯**：表驱动单测 + `shouldResume` 单测 + 1 个 hello 集成测试；不跑 e2e。
