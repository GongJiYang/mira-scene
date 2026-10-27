# PROGRESS（更新于 2026-10-28 00:50，最新提交 a2e7b3a）

## ▶ 下一步（新会话直接从这里开始）
【S6c · 关卡 8/9 · 验收】两批在 worktree 里跑（Systalyze Kimi-K3）：
- S6c 弹幕换背景：`/Users/gjy/mira-wt-s6c`（分支 s6c-scene），日志 `docs/tasks/.s6c-cmd.log`，报告 `s6c-report.md`。
- director 偶发超时小修：`/Users/gjy/mira-wt-flaky`（分支 s6-flaky），报告 `s6-flaky-director-report.md`。
跑完后：核心逐行审、其余看测试 → 合并回 main → 删 worktree。用户在 http://localhost:5180 （主目录 mock dev server）看直播间。

## 并行批次（D42）
- S6d 开发文档窗口：worktree `/Users/gjy/mira-wt-s6d`（分支 s6d-docs），日志 `docs/tasks/.s6d-cmd.log`，报告 `s6d-docs-report.md`。
- S6e 换配色离线工具：worktree `/Users/gjy/mira-wt-s6e`（分支 s6e-recolor），日志 `.s6e-cmd.log`，报告 `s6e-recolor-report.md`。
- **Command Code 周额度已用完（2026-10-27 撞到，周一 20:43 重置）**：三批都在 Systalyze 上跑；真实模式回话（`LLM_PROVIDER=commandcode`）在重置前不可用。
- Systalyze 的模型**不能看图**：`~/.commandcode/config.json` 的 `imageVisionEnabled` 已改为 false（备份 `config.json.bak-20261027`），切回 Command Code 的看图模型时再改回来。
- **模型选择**：Systalyze 的 DeepSeek-V4.1-Flash 频繁报 `Failed to process successful response`（与看图无关），改用 **Systalyze Kimi-K3**（`-m systalyze/moonshotai/kimi-k3`）更稳定。换模型时开新会话，不要 `--continue` 旧模型的会话。
- 验收后由 Claude 合并回 main（S6b 先合），再删 worktree。

## 当前位置
S6a（含 fix1/fix2）已提交 9555a76。S6b 关卡 1–6 已过（D40）：角色包、情景化兜底、忧奈接入舞台（全身 + 低机位卧室背景）、直播间 UI v1、语音包清单、真实生图适配器。

## 已完成（最近的在前）
| 批次 | 结果 | 提交 |
|---|---|---|
| S6a 忧奈预览 / cmd 适配器 / S5-fix / fix1 / fix2 | 547 个测试；D39 | 9555a76 |
| S5 Mock 语音 B / 移动端 / 照片避脸 / WebM 视频 | 479 个测试、e2e 通过；D37 | 1d22b6b |
| D34 可打断时间线 | Q1=0.10ms；432 个测试 | 6edb91a |
| S4 舞台 | 背景/雨/推镜/拍立得/主动开口 | 12cdab1 / 8c5e86c |
| S3 真实语音链路 | Fish TTS/STT、导演层 | 423c55f |

## 排队（按顺序）
1. **S6b**（进行中）→ **S6c 弹幕换背景**（`docs/tasks/s6c.md`、D41，已批准，S6b 提交后派发）。之后：换服装（先换配色，D41）；手机端人物占满屏幕（用户提出，后续再调）。
2. **S6a 推迟项，必须补上**：14 个按键表情 exp3、流泪动作、4096 贴图/压缩纹理。
3. 开发文档窗口（D21）。
4. S6 交付：README（已知问题写「Live2D 自动管线效果不理想」）、AI_USAGE.md、录屏、部署（**cmd 在服务器上怎么用**要解决）。
估计：S6a 1 天 + S6b 1.5 天 + 文档 0.5 天 + 交付 1 天 ≈ 4 个工作日。

## 关键决策（完整记录见 decisions.md D1–D39）
- 每批代码走 mira-code-gate 9 关；代码全部由 cmd 写。派发：先单独一条 `cd ~/mira-scene`，再 `cmd -p …`。**Command Code 5 小时额度到了时**改用 BYOK：`export STLZ_API_KEY=$(grep '^STLZ_API_KEY=' .env | cut -d= -f2-) && cmd -p … -m systalyze/deepseek-ai/deepseek-v4.1-flash-1017 --local-only …`（每轮约 15s；模型已加进 `~/.commandcode/providers.json`，备份 `providers.json.bak-20261027`）。
- LLM 先走 Command Code 额度（`LLM_PROVIDER=commandcode`），首句约 2.5–3s；DeepSeek 适配器保留（D39）。
- Fish 用免费 `s2.1-pro-free`，TTS/STT 实测可用，免费期到 2026-11-30（D39）。
- 余额/额度只提醒，不写降级（D37）。打断时照片保留、视频结束（D37）。
- 两个角色都保留，都做主播；忧奈用正版 Live2D，可公开（D38）。

## 待用户处理
- 审阅 `characters/yuna/prompt.v1.md`、`content.json`；按 `docs/voice-pack.md` 自己录 Mock/兜底语音；在中转站换一个新的生图 Key（旧 Key 出现在聊天记录里）；审阅 `prompts/rin.v1.md` 和信中「暗号」那句。
- iPhone 真机手测 iOS 音频（`docs/tasks/s5-report.md` §7）。

## 不要碰
- `skills/live2d-auto/SKILL.md`、`tools/live2d-pipeline/*`：Live2D 管线会话的改动，不归 Claude 提交。
