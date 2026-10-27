# PROGRESS（更新于 2026-10-28 01:05，最新提交 fc9d752）

## ▶ 下一步（新会话直接从这里开始）
【S6c · 关卡 8/9 · 验收】S6c 弹幕换背景在 worktree `/Users/gjy/mira-wt-s6c`（分支 s6c-scene，Systalyze Kimi-K3）后台跑，日志 `docs/tasks/.s6c-cmd.log`，报告 `docs/tasks/s6c-report.md`。
**新会话先查**：`ps -A -o pid,etime,command | grep "[c]md -p"`；进程没了且没有报告 → 在 worktree 里开新会话续跑（`cd /Users/gjy/mira-wt-s6c` 单独一条，再 cmd -p … 不用 --continue）。核心细审：`detectSceneRequest`、`composeScenePrompt`（构图锁必含）、`sceneJobReducer`（单任务/冷却 45s/每会话 5 次/90s 超时）、切频道取消任务。
跑完后：核心逐行审、其余看测试（必要时自己跑 e2e、自己截图看）→ 合并回 main → 删 worktree。用户在 http://localhost:5180 （主目录 mock dev server）看直播间。

## 当前位置
S6a、S6b（含 fix1–3）、S6d 文档窗口、S6e 换配色离线工具、director 测试超时修复都已在 main。695 个单测全绿、22 个 e2e。

## 接真实模式清单
- [ ] LLM：Command Code 周一 20:43 重置后 `LLM_PROVIDER=commandcode` 即可；或给官方 DeepSeek 充值，改 `LLM_PROVIDER=deepseek`（代码已就绪，首句约 0.8s）。Systalyze 太慢（首 token 14–19s），不用于回话。
- [x] Fish TTS/STT：`s2.1-pro-free` 免费到 2026-11-30；`FISH_VOICE_ID`（夏凛）、`FISH_VOICE_ID_YUNA`（小鸟游星野 a7736406…）已配。
- [x] 生图：`IMAGE_API_KEY`/`IMAGE_BASE_URL` 已配（建议换 Key）。
- [ ] 跑 `pnpm smoke:real` 和 S6c 的 `pnpm smoke:scene`：S6b 后的按角色音色、带对话的生图都还没在真实模式验证过。
- [ ] `PROVIDER_MODE=real pnpm dev`，两个频道各走一遍 arrive→ending（含 reveal 生图、ending 视频、切频道、打断）。
- [ ] iPhone 真机测 iOS 音频。

## 已完成（最近的在前）
| 批次 | 结果 | 提交 |
|---|---|---|
| S6e 换配色离线工具（sakura/mint/mono） | 领结与颈部同图块未换色（已知） | 2f284d6 |
| S6d 开发文档窗口 `?docs=1` | 虚拟模块插件、单一白名单 | 1fdd803 |
| S6b 角色包 / 直播间 UI / 兜底 / 忧奈上舞台 / 语音包清单 / 生图 | fix1–3；D40/D42 | 793e005 |
| S6a 忧奈预览 / cmd 适配器 / S5-fix | D39 | 9555a76 |
| S5 / D34 / S4 / S3 | 见 decisions.md | 1d22b6b 等 |

## 排队（按顺序）
1. S6c（进行中）→ 后续：换配色接运行时（角色包 `palettes` + 渲染器换贴图）、领结按 drawable 细分；手机端人物占满屏幕（用户提出）。
2. S6a 推迟项：14 个按键表情 exp3、流泪动作、4096 贴图/压缩纹理。
3. S6 交付：README、AI_USAGE.md、录屏、部署（线上 LLM 用哪个要定：推荐官方 DeepSeek 充值）。

## 执行环境（重要）
- **Command Code 周额度已用完**（周一 20:43 重置）：写代码的 cmd 用 BYOK `-m systalyze/moonshotai/kimi-k3 --local-only`，派发前 `export STLZ_API_KEY=$(grep '^STLZ_API_KEY=' .env | cut -d= -f2-)`。Systalyze 的 DeepSeek 不稳定，别用。额度恢复后切回 Command Code 的 deepseek-v4-flash（用户 2026-10-27）。
- 真实模式回话（`LLM_PROVIDER=commandcode`）在重置前不可用；Mock 模式正常。
- Systalyze 模型不能看图：`~/.commandcode/config.json` 的 `imageVisionEnabled=false`（备份 `.bak-20261027`），切回能看图的模型时改回。任务里要写「不要打开图片；长命令显式 timeout，超时两次就停」。
- 并行用 git worktree；派发前单独一条 `cd <worktree>`，派发后 `lsof -a -p <pid> -d cwd` 核对；换模型开新会话，不 `--continue`。

## 关键决策（完整记录见 decisions.md D1–D42）
- 每批走 mira-code-gate；代码全部由 cmd 写；Claude 核心逐行审、其余看测试。
- 角色包数据驱动；切频道不保留记录、同连接解绑旧会话；error 带 scope（会话级才跳过 D3 过滤）。
- 弹幕换背景：AI 扩写场景 + 代码锁死构图 + 参考图生图（D41）。
- 余额/额度只提醒，不写降级（D37）。

## 待用户处理
- 审阅 `characters/yuna/prompt.v1.md`、`content.json`、两份 `scene.v1.md`；按 `docs/voice-pack.md` 录 Mock/兜底语音（已按角色分目录，可以开始录）。
- 中转站换一个新的生图 Key（旧 Key 出现在聊天记录里）。
- iPhone 真机手测 iOS 音频。

## 不要碰
- `skills/live2d-auto/SKILL.md`、`tools/live2d-pipeline/*`：Live2D 管线会话的改动，不归 Claude 提交。
