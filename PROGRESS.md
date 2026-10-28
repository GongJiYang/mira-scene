# PROGRESS（更新于 2026-10-28 14:10，最新提交见 `git log -1`；GitHub 公开仓库 https://github.com/GongJiYang/mira-scene）

## ▶ 下一步（新会话直接从这里开始）
【冻结期 · 收尾】用户已在提交（邮件 `~/Desktop/提交邮件.md`，录像 `e2e/out/acceptance/final.mp4`，5:57、200MB）。
1. **freeze-fix9 未完成**：Command Code 周额度用尽（退出码 5，周三 1:18 重置）。改动留在 `/Users/gjy/mira-wt-ff9`（未提交，无报告）。等用户选：`/extra` 按量 / BYOK / 等重置。续跑时提示「先 git diff 核对已完成部分，不要推倒重来」，跑 e2e 带 `E2E_SERVER_PORT=8907 E2E_CLIENT_PORT=5294`。内容：挥手（带噪声对照实测，无效则移除）、开播截图带忧奈参考图、语音识别文字进弹幕、录音脚本按角色 `fishVoiceIdEnv` 取音色。
2. 用户待做：服务器重新跑 `curl -fsSL http://45.128.220.44:8808/deploy.sh | bash` 拿到手机修复；HTTPS（sslip.io + Caddy）与生产构建可选。
3. 后议：结局视频在真实模式被送去生图（HTTP 400）——用户说「后续再讨论」，并要 Claude 在一切做完后根据人物做结尾动画（时间 Claude 定）。

## 当前位置
- main 含 freeze-fix1～8，1091 单测绿，已推送（`922578d` 之后）。真实模式 dev server 在 5181/8791 后台跑。
- 冻结期修复：剧情保底推进、换背景超时分类、LLM 重试、截图期间边翻边聊铺垫、按住说话提前结束（pointerleave）、TTS 降级可读 + 提示、兜底台词卡死（turn_end 后无音频按无声播完 + 预录兜底语音）、手机人物变小（canvas height:auto 回归）、Google Fonts 阻塞（改系统字体 + 自托管 VT323）、麦克风三类提示、手机输入栏声波槽位。
- 素材：6 条忧奈语音误用 Fish 默认男声，已用 `FISH_VOICE_ID_YUNA` 重录（脚本 bug 在 fix9）。
- 交付物：README（八项 + 部署 + 冷启动 19s）、AI_USAGE.md、docs/README.md 文档地图均已推送；README「演示录屏」链接待用户上传后补。

## 已知遗留（README §6 已写主要项）
- 线上 http://IP：浏览器禁麦克风（已有提示）；dev 模式 160 请求；若服务器在境外，国内手机可能直连不上。
- 录像里：挥手看不出抬手；开播截图人物不是忧奈（fix9 处理中）。

## 执行环境（重要）
- cmd 派发：`cd <worktree> && cmd -p "…" -m deepseek/deepseek-v4-flash --skip-onboarding --trust --yolo --tools-all --max-turns 300 < /dev/null > <worktree>/docs/tasks/.<批>-cmd.log 2>&1`，后台跑；并行批次 e2e 必须用不同 `E2E_SERVER_PORT/E2E_CLIENT_PORT`。
- 任务说明必写：不要打开图片；长命令显式 timeout；只准停自己启动的进程（禁止 `pkill -f vite`）。
- 录屏：`REC=<scratchpad>/screenrec/screenrec OUT=… node e2e/out/acceptance/record-final.mjs`（ScreenCaptureKit 录 Chrome for Testing 窗口 + 系统音频；源码在会话 scratchpad，可能已清理，需要时重写）。
- Fish：STT 走额度（曾因余额不足返回空 → 「没听清」）；TTS 用免费模型。
- worktree：mira-wt-ff1…ff9 可在 fix9 合并后删除。

## 关键决策（完整见 decisions.md D1–D49 + freeze-fix 裁定）
- D48 冻结只修 bug；D49 浏览器自带 Key（部署时服务端 Key 优先给访问者用）。
- cmd 在 freeze-fix6 报告里编造「已与用户确认」，已记入 ai-usage-log。

## 不要碰
- `skills/live2d-auto/SKILL.md`、`tools/live2d-pipeline/*`（用户让提交的已提交）。
