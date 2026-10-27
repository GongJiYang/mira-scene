# PROGRESS（更新于 2026-10-27，最新提交 1b2ef1e；S6a 已派发、未提交）

## ▶ 下一步（新会话直接从这里开始）
【S6a · 关卡 8/9 · 验收】cmd 正在后台执行 `docs/tasks/s6a.md`（日志 `docs/tasks/.s6a-cmd.log`，报告 `docs/tasks/s6a-report.md`）。跑完后：自己重跑 test/typecheck/smoke/e2e + `pnpm smoke:real`（LLM_PROVIDER=commandcode）→ 核对关卡结论 → **开浏览器 `/?preview=yuna` 给用户看忧奈** → 提交。

## 当前位置
S6a 关卡 1–6 已过（D39）。范围：① 忧奈 Live2D 预览页 ② Command Code LLM 适配器 ③ S5-fix。

## 已完成（最近的在前）
| 批次 | 结果 | 提交 |
|---|---|---|
| S6a 关卡 1–6 | D39、docs/tasks/s6a.md | 未提交 |
| S5 Mock 语音 B / 移动端 / 照片避脸 / WebM 视频 | 479 个测试、e2e 通过；D37 | 1d22b6b |
| D34 可打断时间线 | Q1=0.10ms；432 个测试 | 6edb91a |
| S4 舞台 | 背景/雨/推镜/拍立得/主动开口 | 12cdab1 / 8c5e86c |
| S3 真实语音链路 | Fish TTS/STT、导演层 | 423c55f |

## 排队（按顺序）
1. **S6b**：角色包（夏凛 + 忧奈配置化）、直播间 UI v1（仿 Twitch：左画面右弹幕、底部弹幕框 + 麦克风、最左窄栏切频道、手机上下结构，风格参考《主播女孩重度依赖》）、忧奈剧情/提示词/Mock 剧本（**Claude 写初稿给用户审**）、忧奈 Fish 音色 + Mock 语音按角色分开。
2. **S6a 推迟项，必须补上**：14 个按键表情 exp3、流泪动作、4096 贴图/压缩纹理。
3. 开发文档窗口（D21）。
4. S6 交付：README（已知问题写「Live2D 自动管线效果不理想」）、AI_USAGE.md、录屏、部署（**cmd 在服务器上怎么用**要解决）。
估计：S6a 1 天 + S6b 1.5 天 + 文档 0.5 天 + 交付 1 天 ≈ 4 个工作日。

## 关键决策（完整记录见 decisions.md D1–D39）
- 每批代码走 mira-code-gate 9 关；代码全部由 cmd 的 DeepSeek 写。派发：先单独一条 `cd ~/mira-scene`，再裸的 `cmd -p …`。
- LLM 先走 Command Code 额度（`LLM_PROVIDER=commandcode`），首句约 2.5–3s；DeepSeek 适配器保留（D39）。
- Fish 用免费 `s2.1-pro-free`，TTS/STT 实测可用，免费期到 2026-11-30（D39）。
- 余额/额度只提醒，不写降级（D37）。打断时照片保留、视频结束（D37）。
- 两个角色都保留，都做主播；忧奈用正版 Live2D，可公开（D38）。

## 待用户处理
- 审阅忧奈台词/提示词初稿（S6b 时提供）；审阅 `prompts/rin.v1.md` 和信中「暗号」那句。
- iPhone 真机手测 iOS 音频（`docs/tasks/s5-report.md` §7）。

## 不要碰
- `skills/live2d-auto/SKILL.md`、`tools/live2d-pipeline/*`：Live2D 管线会话的改动，不归 Claude 提交。
