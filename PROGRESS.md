# PROGRESS（更新于 2026-10-28 11:20，最新提交见 `git log -1`；GitHub 公开仓库 https://github.com/GongJiYang/mira-scene）

## ▶ 下一步（新会话直接从这里开始）
【冻结期 · freeze-fix1 验收】
1. 先看 cmd 是否跑完：`pgrep -fl command-code`；`ls /Users/gjy/mira-wt-ff1/docs/tasks/freeze-fix1-report.md`。还在跑就等；进程没了但没有报告 → 同一 worktree 续跑，提示「先 git diff 核对已完成部分，不要推倒重来」。
2. 跑完后：worktree 里自己跑 `pnpm test` + `pnpm typecheck`；审核心（`director/forcedAdvance.ts`、`adapters/deepseek/llmRetry.ts`、`scene/runner.ts` 错误分类、动作表参数实测表与处理），再提交 → 合并 → 推送。
3. **重启用户的真实模式 dev server**（被 cmd 的 `pkill -f vite` 杀掉了）：在 main 后台跑 `PROVIDER_MODE=real PORT=8791 MIRA_CLIENT_PORT=5181 MIRA_SERVER_PORT=8791 pnpm dev`。然后在 5181 复测：动作表逐项、剧情能否走到 ending、第二次换背景。
4. 然后按 `docs/tasks/delivery.md` 执行：冷启动验证（结果填进 README「冷启动实测」）→ README「已知问题」按 freeze-fix1 实测更新 → 写 AI_USAGE.md → 录屏（ScreenCaptureKit 小工具；用户需给终端授权屏幕录制一次）。
   - 已做（3634bdf）：README 初稿（八项 + 可选扩展，⏳ 标记待填）、`docs/README.md` 文档地图、导读更新到冻结点、checklist 并入导读、roadmap 标历史、`.env.example` 改 IMAGE_*、cmd 日志移出仓库、删 shot-tmp.mjs。
   - 推送前：`tools/live2d-pipeline/config.refpack.json` 有 16 处 `/Users/gjy` 绝对路径（7c8a596 提交，用户让提交），问用户是否改相对路径。

## 当前位置
- 功能已冻结（D48）。main 含 S6c-fix1 到 S6u 全部批次，969 个单测全绿。
- 冻结点检查已做：e2e 全量（44 过 / 5 败，失败的都是测试断言写错）、真实模式走查、动作表逐项量化。
- 发现的问题都写进 `docs/tasks/freeze-fix1.md`，已派发到 `/Users/gjy/mira-wt-ff1`（10:00 时已跑 66 分钟，正在做 §4 参数探针）。要修的是：
  - 剧情保底推进（真实模式 9 轮卡在 probe）
  - 换背景单张图片 60s 超时，失败原因被报成 aborted
  - LLM 遇到 `fetch failed` 时重试
  - 动作表：挥手无效；爱心眼 / 脸黑 / 黑眼圈 / 哭看不出；平静、中性、惊讶看起来一样
  - S6u 三处：时长写死 02:14:37、手机端标题条压住头、手机端 ⇅ 按钮
  - smoke 固定走 Mock
  - 修正 3 个 e2e 用例

## 交付（`docs/tasks/delivery.md`）
- 六项交付的方案、录屏分镜都在这个文件里。
- 投入时间估算：人工约 30–35h、AI 后台约 20h（用户说「大约估算」，已写入，可改）。

## 测试策略
- 各批 cmd 不跑 e2e，冻结后统一跑。freeze-fix1 例外，只跑它改过的 3 个 spec。
- 每批合并前，Claude 独立审核心和易错部分，不能只看测试（用户要求）。

## 执行环境（重要）
- cmd 派发命令：`cd <worktree> && cmd -p "…" -m deepseek/deepseek-v4-flash --skip-onboarding --trust --yolo --tools-all --max-turns 800 < /dev/null > <worktree>/docs/tasks/.<批>-cmd.log 2>&1`，后台跑。
- 派发后用 `lsof -a -p <pid> -d cwd` 核对工作目录。停 cmd 要停 `command-code` 进程本身。
- 会撞 Command Code 的 5 小时额度（退出码 5）：在同一 worktree 续跑，只提醒用户。
- 任务说明里必须写明：不要打开图片；长命令显式 timeout；**只准停自己启动的进程，禁止 `pkill -f vite` 这类宽匹配**（这次因此杀掉了用户的 dev server）。
- worktree 建法：`git worktree add -b <批> /Users/gjy/mira-wt-<批> main` → 拷 `.env` → `pnpm install --offline`。旧 worktree（s6cfix1、s6k、s6l、s6lfix1、s6lfix2、s6m、s6n、s6u）可以删。
- 和用户只讨论技术、体验、UI 方面的问题，设定类细节自己定。

## 关键决策（完整见 decisions.md D1–D49）
- D47：accent 表情。
- D48：路线冻结，只修 bug；不做的写进「两周演进」（含 Live2D 自动化 AI 流水线、Drama3 本地部署 30B）。
- D49：浏览器自带 Key + 每个会话自己选模式（铁律已同步修改 CLAUDE.md）。
- 设计稿：https://claude.ai/artifact/JW9iubkP3j5wQQuxpZuqgA ，源文件在 `docs/design/s6u/`。

## 待用户处理
- 录屏前给终端授权「屏幕录制」。
- 审 README 初稿（已提交 3634bdf，未推送）/ AI_USAGE（未写）。
- 试听 `assets/voice/yuna/clips/` 和 `characters/yuna/sfx/`。
- 部署（可选，服务器在用户手里）。

## 不要碰
- `skills/live2d-auto/SKILL.md`、`tools/live2d-pipeline/*`。
