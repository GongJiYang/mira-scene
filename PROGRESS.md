# PROGRESS（更新于 2026-10-28 02:55，最新提交见 `git log -1`；GitHub 公开仓库 https://github.com/GongJiYang/mira-scene）

## ▶ 下一步（新会话直接从这里开始）
【S6c-fix1 · 派发】先 `git status -sb` 看 main 是否已推送（未推送就 `git push -u origin main`）；然后 `git worktree add -b s6c-fix1 /Users/gjy/mira-wt-s6cfix1 main`，拷 `.env`、`pnpm install --offline`，单独一条 `cd` 进 worktree，用 cmd 派发 `docs/tasks/s6c-fix1.md`（**先把下方「已知待修」前 4 条追加进任务说明**）。跑完简单检测 → 合并 → main 跑 `pnpm test`+`pnpm typecheck` → 推送 → 写 S6k 任务说明并派发。

## 当前位置
main 已含 S6c（换背景）、S6f（四态）、S6h（观测页）、S6g-A（删夏凛；剧情视觉进角色包 `nodeVisuals`；Live2D 舞台镜头推近/拉远、stream_dim、hearts、截图卡片、ending 视频加载/结束/打断；眉毛写物理输入；抱熊渐变；首页「文档」「观测」入口）。717 单测全绿。夏凛已彻底删除（D43）。

## 排队（一次只跑一批）
**P0 必做**
1. **S6c-fix1**（`docs/tasks/s6c-fix1.md`）：busy 兜底 seq 冲突吞真实回复、异步失败兜底被 turnId 丢弃（改剧情层）、90s 超时未生效、sceneController 恢复不重建、MIME、`$` 替换、参考图用当前背景。三条兜底预录已合成（`apps/client/public/characters/yuna/voice/fallback/scene_*.mp3`）。
2. **S6k** 语境表情（D47）：LLM 可选 `accent` + 导演层冷却/冲突/规则触发 + 0.4s 渐变；全部表情开关放开，只有 `Param1–10` 恒为 0；提示词新增段交用户审。（任务说明还没写）
3. 真实模式全流程走查（浏览器 arrive→ending、打断、生图、视频、断线）。
4. README（8 项，复用 `docs/architecture/00-导读.md`）+ AI_USAGE.md；更新 `docs/checklist.md`（仍是夏凛时代的旧状态）。
5. 部署（演示地址；手机测试依赖它）。
**P1 加分**
6. **S6i** 弹幕 @ 指令（D45：@换地方 / @动作 / @送礼物）。
7. **S6g-B**：主身体 X/Z 驱动 + 音频起伏（D46②）、倾听加大；D44 透明关推流视频（现在 ending 视频不透明，整个盖住忧奈）；生成内容缓存。
8. 录屏（用户，P1 后）；iPhone 真机（用户，部署后）。
**P2 后续**：手臂/尾巴/耳朵物理后覆盖 + 动作测试页（D46③）；换配色接运行时；手机人物占满屏。

## 已知待修（并入 S6c-fix1）
- ending 时截图卡片没收起，叠在 OFFLINE 视频上。
- 「平静」情绪截图里猫耳朵不见了（「防备」有），疑与 S6g-A 删耳朵动作有关，查 `ParamEarOFF` / 耳朵参数是否被写。
- 「温暖」情绪的 e2e 截图在 ending 视频播放时截的，人物被挡住，改为在视频前截。
- 文档页手机横向溢出 6px（`e2e/docs.spec.ts` 失败），疑为 `00-导读.md` 的宽代码块，代码块需在卡片内横向滚动。
- 输入框占位文字「‹输入框占位›」：**等用户给正式文案**，不要自己写。

## 待统一深审（用户要求：现在只做简单检测，功能做完后统一做）
S6g-A、S6c-fix1、S6k 及之后各批：核心逐行审 + `/code-review high` 二审 + 浏览器实测打断 / 剧情层不作废 / turnId 过滤。

## 执行环境（重要）
- cmd：Command Code 账号 GongJiYang，`cmd -p "…" -m deepseek/deepseek-v4-flash --skip-onboarding --trust --yolo --tools-all --max-turns 800 < /dev/null > docs/tasks/.<批>-cmd.log 2>&1`（后台跑）。Systalyze 限流已停用。网络断开过一次（退出码 6）→ 同 worktree 新会话续跑，提示「先核对已完成部分，不要推倒重来」。
- 一次只跑一批；派发前单独一条 `cd <worktree>`，派发后 `lsof -a -p <pid> -d cwd` 核对。任务里写「不要打开图片；长命令显式 timeout」。用户已授权直接派发。
- 真实模式 dev server：http://localhost:5181（`PROVIDER_MODE=real PORT=8791 MIRA_CLIENT_PORT=5181 MIRA_SERVER_PORT=8791 pnpm dev`，改代码会自动重启）。5180/8790 是旧 Mock 服务器（Claude 停不了，用户可 `kill 49797 77336`）。实测 DeepSeek 首句 0.8–1.1s、首包 2.2–2.7s；换背景生图约 45s。
- 忧奈语音补录：之前用的是会话临时目录里的一次性脚本（新会话里已不存在）；需要补录时让 cmd 给 `apps/server/scripts/record-voices.ts` 加 `--character`。

## 关键决策（完整见 decisions.md D1–D47）
D43 只做忧奈；D44 关推流透明视频；D45 @ 指令；D46 物理覆盖（眉毛写输入、主身体 X/Z、物理后覆盖）；D47 全部表情按语境（accent）。Live2D 商用模型按用户选择**原样公开**在仓库里（用户知悉授权风险）。

## 待用户处理
- 输入框正式提示文案；试听 `assets/voice/yuna/clips/`；换生图 Key；iPhone 真机。

## 不要碰
- `skills/live2d-auto/SKILL.md`、`tools/live2d-pipeline/*`。
