# PROGRESS（更新于 2026-10-27 18:30，最新提交 1d22b6b）

## ▶ 下一步（新会话直接从这里开始）
【S6a · 关卡 1/9 · YAGNI】先问清用户要谈的**语音**事项（忧奈的 Fish 音色、Mock 预录语音按角色分开）；然后调用 mira-code-gate + sdframe，就「S5-fix + 角色包 + 忧奈 Live2D 接入」提出 5 个关卡问题和建议答案，等用户批准。

## 当前位置
S5 已验收并提交。题目对照表见 `docs/checklist.md`（每次存档时一起更新）。

## 已完成（最近的在前）
| 批次 | 结果 | 提交 |
|---|---|---|
| S5 Mock 语音 B / 移动端 / 照片避脸 / WebM 视频 | 479 个测试、e2e 通过；D37 | 1d22b6b |
| D34 可打断时间线 | Q1=0.10ms；432 个测试 | 6edb91a |
| S4 舞台 | 背景/雨/推镜/拍立得/主动开口 | 12cdab1 / 8c5e86c |
| S3 真实语音链路 | Fish TTS/STT、导演层 | 423c55f |
| S5-1 故障注入 + G2 探针 | 首句 P50 766ms | 485982d |

## 排队（按顺序）
1. **S6a**：
   - S5-fix：ending 前的空白相纸、reveal 照片被视频替换；
   - 角色包：夏凛和忧奈都做成配置；
   - 忧奈 Live2D：用 Cubism Web SDK 5，贴图另出 2048–4096 的网页版本，自己做呼吸，四情绪用参数组合，模型放进 `assets/models/yuna`（源文件在 `/Users/gjy/tools/models/yuna/`，分析见同目录的 REPORT.md）。
2. 忧奈的故事、提示词和 Mock 剧本：方向一「下播之后」（D38）。**台词和提示词由用户写**，风格参考《主播女孩重度依赖》。
3. UI 设计：用户会往《主播女孩重度依赖》的方向靠，等设计稿。
4. 开发文档窗口（D21）。
5. S6 交付：README（已知问题里写「Live2D 自动管线效果不理想」）、AI_USAGE.md、录屏（先排好演示路线、预演）、部署。

## 关键决策（完整记录见 decisions.md D1–D38）
- 每批代码都走 mira-code-gate 的 9 个关卡；所有代码由 Command Code（`cmd`）的 DeepSeek 写。派发时先用一条单独的 Bash 命令 `cd` 到项目目录，再执行裸的 `cmd -p …`（允许规则只匹配这个形式）。
- 余额/额度不在项目范围，只提醒用户（D37）。
- 打断时照片保留，视频就此结束（D37）。
- 两个角色都保留：夏凛用分层立绘，忧奈用正版 Live2D（D38，授权已确认，可以放进公开仓库）。

## 待用户处理（阻塞项）
- 给 Fish 和 DeepSeek 充值（402）；之后跑 `pnpm smoke:real` 和 `pnpm voices:record`。
- 语音的事（用户要谈）；忧奈的台词和提示词；UI 设计稿；审阅 `prompts/rin.v1.md` 和信中「暗号」那句话。
- iPhone 真机手测 iOS 音频（清单见 `docs/tasks/s5-report.md` §7）。

## 不要碰
- `skills/live2d-auto/SKILL.md`、`tools/live2d-pipeline/*`：Live2D 管线会话的改动，不归 Claude 提交。
