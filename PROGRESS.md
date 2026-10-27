# PROGRESS（更新于 2026-10-28 01:40，最新提交见 git log -1）

## ▶ 下一步（新会话直接从这里开始）
【S6c · 关卡 8/9 · 验收】S6c 在 worktree `/Users/gjy/mira-wt-s6c` 用 Command Code `deepseek/deepseek-v4-flash` 续跑（日志 `docs/tasks/.s6c-cmd.log`，报告 `docs/tasks/s6c-report.md`）。先查 `ps -A -o pid,etime,command | grep "[c]md -p"`；进程没了且没报告 → worktree 里开新会话续跑（不 `--continue`）。核心细审：`detectSceneRequest`、`composeScenePrompt`（构图锁必含）、`sceneJobReducer`（单任务/冷却 45s/每会话 5 次/90s 超时）、切频道取消。合并后派 S6g-1。

## 当前位置
main 已含 S6f（隐藏夏凛 + 忧奈四态）、S6h（观测页 `?obs=1` + `?hud=1`）。744 单测全绿。真实模式 dev server：http://localhost:5181（服务端 8791，`PROVIDER_MODE=real PORT=8791 MIRA_CLIENT_PORT=5181 MIRA_SERVER_PORT=8791 pnpm dev`）；5180/8790 是旧 Mock 服务器（自动模式不让 Claude 停，用户可 `kill 49797 77336`）。真实模式实测：DeepSeek 首句 0.8–1.1s，首包 2.2–2.7s，会接话。

## 排队（按顺序，一次只跑一批）
1. **S6c**（进行中）弹幕换背景。
2. **S6g-1**：删夏凛（D43，含 S6f 的 `hidden` 字段）；D46 表演与物理修正（眉毛写 `ParamBrowL/R`、主身体 X/Z 驱动、物理后覆盖：举罐/挥手/摇尾巴/耳朵）；S6f 遗留（倾听加大、瞟眼走 clampView、禁止参数清零挪到最后）；**直播间加「文档」「观测」入口按钮**（用户要求，桌面顶栏、手机菜单）；观测页瀑布条改统一时间刻度。
3. **S6g-2**：剧情节点视觉搬进角色包；Live2D 舞台补镜头（reveal 推近、ending 拉远）、特效（stream_dim、hearts=ParamHeart/ParamLove、chat_burst）、截图弹窗；D44 透明关推流视频（WebM alpha + HEVC alpha，CSS 降级）；生成内容缓存。
4. **S6i**：D45 弹幕 @ 指令（@换地方 / @动作 / @送礼物）。
5. 交付：README（复用 `docs/architecture/00-导读.md`）、AI_USAGE.md、录屏、部署、iPhone 真机。

## 执行环境（重要）
- cmd 现在登录用户的另一个 Command Code 账号（GongJiYang），用 `-m deepseek/deepseek-v4-flash --skip-onboarding --trust --yolo --tools-all`，不加 `--local-only`。**Systalyze 会限流（Rate limit exceeded，退出码 5），停用**。
- **一次只跑一批**（并行会撞限流）。派发前单独一条 `cd <worktree>`，派发后 `lsof -a -p <pid> -d cwd` 核对。
- `~/.commandcode/config.json` 的 `imageVisionEnabled=false`；任务里写「不要打开图片；长命令显式 timeout」。
- 用户已授权 Claude 直接派发 cmd。

## 关键决策（完整见 decisions.md D1–D46）
- D43 只做忧奈，夏凛删除；D44 关推流透明视频叠在常驻 Live2D 上；D45 弹幕 @ 指令；D46 物理覆盖问题与修法。
- 每批走 mira-code-gate（关卡 1–5 由 Claude 写进任务说明末尾）；代码全部由 cmd 写；Claude 核心逐行审、截图自己看。

## 待用户处理
- 审阅 `docs/architecture/00-导读.md`（含 Live2D 管线失败说明）和 `live2d-pipeline.md` 开头结论——**未提交，等用户确认**。
- 试听忧奈预录语音 `assets/voice/yuna/clips/`。
- 中转站换生图 Key；iPhone 真机测音频。

## 不要碰
- `skills/live2d-auto/SKILL.md`、`tools/live2d-pipeline/*`。
