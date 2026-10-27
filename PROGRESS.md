# PROGRESS（更新于 2026-10-28 04:10，最新提交见 `git log -1`；GitHub 公开仓库 https://github.com/GongJiYang/mira-scene）

## ▶ 下一步（新会话直接从这里开始）
【S6l · 关卡 8/9】S6l 已在 `/Users/gjy/mira-wt-s6l` 派发（command-code，`docs/tasks/s6l.md`，日志 `.s6l-cmd.log`）。跑完：简单检测 → 提交分支 → 合并 → main 跑 test+typecheck → 推送。然后走 S6m（动作对比页）关卡。

## 当前位置
main 已经包含 S6c-fix1（换背景旁路修复 + 4 个界面问题）和 S6k（语境表情 accent，D47），共 787 个单测全绿，已推送。**路线已冻结（D48）**，依据是题目原文 `/Users/gjy/Downloads/0912-candidate(1) (1).pdf`。

## 冻结路线（D48；一次只跑一批；冻结点之后只修 bug）
1. ✅ S6c-fix1、S6k
2. **S6l 剧情可感知**：
   - 修 arrive→probe 卡死（`advanceRule` 在 arrive 只写「允许进入 reveal」，`story.ts` 只放行 arrive→probe）
   - 顶部显示剧情阶段 + 进度点
   - **观众弹幕引导**：按阶段刷话题弹幕，点一下就作为自己的话发出（用户点名喜欢这个）
   - 沉默时按阶段抛钩子；戳忧奈触发表情反应；送礼物（love + heart）
   - 点击打断
   - 设定为成年：22 岁、刚毕业的个人势主播
   - 输入框文案「发条弹幕，或按住麦克风说话」
2b. **S6l-fix1**（`docs/tasks/s6l-fix1.md`，已写好）：①第二次换背景必失败（参考图路径映射到了不存在的 client/public/generated，实际在 var/generated；且失败不记日志）；②刷新后生成背景和用户弹幕丢失（服务端 `session` 消息只回 snapshot）。S6l 合并后立即派发（两批都改 `session.ts`/`messages.ts`，不能并行）。
3. **S6m 动作表面板（用户 2026-10-28 要求，取代单独的动作对比页）**：主界面放一个可收起的「动作表」（桌面在弹幕窗口顶部做可展开标签，手机收进右上角菜单，默认收起），列出情绪 6 种、accent 表情 10 种、现有动作 4 种（drink/glance/phone/show_item）、新动作（挥手 / 摇尾 / 抖耳 / 身体晃，每个 A 参数法 / B motion3 法并排给用户比较，选定后删掉落选版本）。点一下忧奈在舞台上演一遍；**只在本地预览**，不发服务端、不算一轮、不影响剧情；说话中置灰。样式按 S6u 设计稿，S6u 时在设计稿里补一张面板图。
4. **S6u Web UI 重设计**：用户不喜欢 DeepSeek 的界面风格。**设计稿用户已批准（2026-10-28）**：https://claude.ai/artifact/JW9iubkP3j5wQQuxpZuqgA（「深夜推流」4 张：桌面说话中 / 手机说话中 / 手机按住说话 / 设计规范）。写 `docs/tasks/s6u.md` 时先用 Artifact read 取回源文件，把 token、布局、四态状态牌、字幕名牌、引导弹幕样式逐条抄进任务说明，cmd 按稿实现。
5. **冻结点**
6. 真实模式全流程走查 + 统一深审（`/code-review high`），然后出 fix 批。
7. 冷启动验证（新克隆、无 Key、一条命令跑通 Mock）——必须等所有功能结束后再做。
8. 文档收尾（最后统一改）：
   - README 八项（含第三方来源、「已完成的可选扩展」一节、打断方式的理由）
   - AI_USAGE.md
   - 重写 checklist
   - 导读注明夏凛 → 忧奈的变更
   - cmd 日志移出仓库（目前已有 44 份提交到了公开仓库）
9. 录屏：Claude 先尝试自动录（Playwright + 屏幕录制）并出分镜，不行再由用户录。

**可选（全部做完再看）**：D44 透明结局视频（用户想看效果）；部署（最后做）。
**不做，写进 README「两周演进」**：VAD、@ 指令（S6i 取消）、剧情分支、生成内容缓存、物理覆盖、运行时换配色、手机人物满屏、Live2D 自动化 AI 制作流水线、Drama3 本地部署（30B）。

## 待统一深审（用户要求：现在只做简单检测，功能做完后统一深审）
- 范围：S6g-A、S6c-fix1、S6k 以及之后的各批。
- 方式：核心代码逐行审 + `/code-review high` + 浏览器实测（打断、剧情层不作废、turnId 过滤）。
- 专项要确认：
  - 「平静」情绪下耳朵是否可见（S6c-fix1 只是把 `ParamEarOFF` 写成 0，根因未证实）
  - accent 在真实对话里的效果
  - `pnpm smoke` 在 S6k 里走的是真实模式（`.env` 里设了 `PROVIDER_MODE=real`），要核实 smoke 是否应该固定用 Mock

## 执行环境（重要）
- cmd 派发命令：`cd <worktree> && cmd -p "…" -m deepseek/deepseek-v4-flash --skip-onboarding --trust --yolo --tools-all --max-turns 800 < /dev/null > <worktree绝对路径>/docs/tasks/.<批>-cmd.log 2>&1`，后台跑。
  - 必须和 `cd` 写在同一条命令里，单独一条 `cd` 会被重置回 main。
  - 派发后用 `lsof -a -p <pid> -d cwd` 核对工作目录。
  - 停 cmd 要停 **`command-code` 进程本身**，只杀外层 zsh 它会继续跑（这次因此在 main 上误改了 30 分钟；改动已备份并还原）。
  - 任务说明里写明「不要打开图片；长命令显式 timeout」。用户已授权直接派发。
- worktree 建法：`git worktree add -b <批> /Users/gjy/mira-wt-<批> main`，再拷 `.env`、跑 `pnpm install --offline`。旧 worktree `mira-wt-s6cfix1`、`mira-wt-s6k` 可以删。
- 真实模式 dev server：http://localhost:5181（`PROVIDER_MODE=real PORT=8791 MIRA_CLIENT_PORT=5181 MIRA_SERVER_PORT=8791 pnpm dev`）。5180/8790 是旧的 Mock 服务器，用户可以 `kill 49797 77336` 停掉。
- 和用户讨论只问技术、体验和 UI 的问题，设定类细节由 Claude 自己定。

## 关键决策（完整见 decisions.md D1–D48）
- D43 只做忧奈
- D44 透明结局视频
- D46 物理覆盖
- D47 accent 表情
- D48 路线冻结
- Live2D 商用模型按用户的选择原样公开

## 待用户处理
- 试听 `assets/voice/yuna/clips/`
- 换生图 Key

## 不要碰
- `skills/live2d-auto/SKILL.md`、`tools/live2d-pipeline/*`。
