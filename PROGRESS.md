# PROGRESS（更新于 2026-10-28 01:40，最新提交见 git log -1）

## ▶ 下一步（新会话直接从这里开始）
【S6g-A · 关卡 8/9 · 验收】S6g-A 在 worktree `/Users/gjy/mira-wt-s6ga`（分支 s6g-a，cmd deepseek-v4-flash）后台跑，日志 `docs/tasks/.s6ga-cmd.log`，报告 `docs/tasks/s6g-a-report.md`。先查 `ps -A -o pid,etime,command | grep "[c]md -p"`；进程没了且没报告 → worktree 里开新会话续跑。验收：逐张看 e2e/out/s6ga-*.png（推近/变暗/截图弹窗/爱心/视频/四情绪眉毛/抱熊渐变），核心审导演层读 `pack.nodes`、`cameraFor`、眉毛物理映射；合并后派 S6k。

## 当前位置
main 已含 S6f（隐藏夏凛 + 忧奈四态）、S6h（观测页 `?obs=1` + `?hud=1`）。744 单测全绿。真实模式 dev server：http://localhost:5181（服务端 8791，`PROVIDER_MODE=real PORT=8791 MIRA_CLIENT_PORT=5181 MIRA_SERVER_PORT=8791 pnpm dev`）；5180/8790 是旧 Mock 服务器（自动模式不让 Claude 停，用户可 `kill 49797 77336`）。真实模式实测：DeepSeek 首句 0.8–1.1s，首包 2.2–2.7s，会接话。

## 排队（2026-10-28 重排；一次只跑一批）
**P0 必做**
1. ~~S6c~~ 已合并（38a967b）：真实生图 44.6s，构图锁有效。
2. **S6g-A**：Live2D 舞台补渲染（reveal 推近 + stream_dim、ending 拉远 + 爱心 ParamHeart/ParamLove；截图弹窗含生成中/失败退回预置；ending 视频加载/结束/打断）；剧情节点视觉搬进角色包（去掉导演层写死的雨/photo_letters/clip_ending）；删夏凛（D43，含 `hidden`）；情绪眉毛改写 `ParamBrowL/R`（D46①）；抱熊移出待机随机、0→1 渐变（用户反馈突兀）；直播间「文档」「观测」入口按钮（桌面顶栏、手机菜单）；S6f 遗留（瞟眼走 clampView、禁止参数清零挪到最后）。
3. **S6k** 语境表情（D47）：LLM 可选 `accent` 字段 + 导演层冷却/冲突规则 + 渲染渐变；全部表情开关放开，只有 Param1–10 恒为 0；提示词新增段交用户审。
4. 真实模式全流程走查（Claude 用浏览器 arrive→ending、打断、生图、视频、断线，截图）。
5. README（8 项，复用 `00-导读.md`）+ AI_USAGE.md。
6. 部署（演示地址；也解决手机 localhost 问题）。
**P1 加分**
7. **S6i** 弹幕 @ 指令（D45）。
8. **S6g-B**：主身体 X/Z 驱动 + 音频驱动起伏（D46②）、倾听加大；D44 透明关推流视频；生成内容缓存；观测页瀑布条统一刻度。
9. 录屏（用户，P1 完成后）；iPhone 真机（用户，部署后）。
**P2 后续**（用户 2026-10-28 决定推后）
10. 手臂/尾巴/耳朵物理后覆盖（D46③）+ 动作测试页（逐参数扫范围截图）；挥手/举罐/摇尾巴。
11. 换配色接运行时、手机端人物占满屏幕、其余表情开关。

## 执行环境（重要）
- cmd 现在登录用户的另一个 Command Code 账号（GongJiYang），用 `-m deepseek/deepseek-v4-flash --skip-onboarding --trust --yolo --tools-all`，不加 `--local-only`。**Systalyze 会限流（Rate limit exceeded，退出码 5），停用**。
- **一次只跑一批**（并行会撞限流）。派发前单独一条 `cd <worktree>`，派发后 `lsof -a -p <pid> -d cwd` 核对。
- `~/.commandcode/config.json` 的 `imageVisionEnabled=false`；任务里写「不要打开图片；长命令显式 timeout」。
- 用户已授权 Claude 直接派发 cmd。

## 关键决策（完整见 decisions.md D1–D47）
- D43 只做忧奈，夏凛删除；D44 关推流透明视频叠在常驻 Live2D 上；D45 弹幕 @ 指令；D46 物理覆盖问题与修法。
- 每批走 mira-code-gate（关卡 1–5 由 Claude 写进任务说明末尾）；代码全部由 cmd 写；Claude 核心逐行审、截图自己看。

## 待用户处理
- 审阅 `docs/architecture/00-导读.md`（含 Live2D 管线失败说明）和 `live2d-pipeline.md` 开头结论——**未提交，等用户确认**。
- 试听忧奈预录语音 `assets/voice/yuna/clips/`。
- 中转站换生图 Key；iPhone 真机测音频。

## 不要碰
- `skills/live2d-auto/SKILL.md`、`tools/live2d-pipeline/*`。
