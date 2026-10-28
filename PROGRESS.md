# PROGRESS（更新于 2026-10-28 11:20，最新提交见 `git log -1`；GitHub 公开仓库 https://github.com/GongJiYang/mira-scene）

## ▶ 下一步（新会话直接从这里开始）
【冻结期 · 验收】freeze-fix1 已合并（fe54f99，999 单测绿，未推送）。真实模式 dev server 在 5181/8791 后台跑。
1. 等用户按视觉实测表回报 → 连同下面 4 条一起写 `docs/tasks/freeze-fix2.md` 派 cmd：
   - 真实模式结局视频永不播放：`createImageGenMedia.preset` 对 video 也去生图 → HTTP 400（应委托 presetMedia）。
   - 换背景误触发：`content.json sceneTriggers` 的 `去.{0,6}(吧|呀|看看)` 命中「去睡吧」。
   - `?fail=` 在恢复会话时不生效（刷新复用旧会话，faults 只在 session_created 时读）。
   - 低：runner 单张超时与 imageGen 内部计时器同时长，竞态时仍记 `error: aborted`。
   - 参数探针 `e2e/param-probe.spec.ts` 基准只取一次、无噪声对照，表里 30–40% 多为动画噪声，结论不可用。
2. 修完后重录验收（`node e2e/out/acceptance/record.mjs`，MOBILE=1 跑手机），再推送。
3. 推送前问用户：`config.refpack.json` 16 处 `/Users/gjy` 绝对路径是否改相对。
4. 之后：冷启动验证 → README 待填项 → AI_USAGE → 正式录屏（带声音，需屏幕录制授权）。

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
