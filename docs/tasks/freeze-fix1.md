# freeze-fix1 任务说明：冻结后第一批修复（深审 + e2e + 真实模式走查）

> 来源：冻结点后 Claude 的统一检查（2026-10-28）：e2e 全量（44 过 / 5 败 / 9 跳过）、真实模式浏览器走查（5181，DeepSeek + Fish + 生图）、动作表逐项截图量化、用户反馈「S6u 很多动作做不了」。以下问题均已核实。执行者：Command Code（deepseek-v4-flash）。冻结期：**只修 bug，不加功能**。

## 铁律
冲突停下写进报告；Key 规则见 CLAUDE.md（D49）；不准 commit；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片；长命令显式传大 timeout，同一命令超时两次就停下写进报告；测试里不发真实网络请求；**这批要跑 e2e**（§8，只跑改过的 spec）。每条先写会失败的测试再改。不改台词。

## §1 真实模式剧情推进不可靠（高）
- 现象：走查 9 轮停在 probe。日志里 arrive→probe 被 LLM 提出并接受，之后 LLM 从未输出 `advance:"reveal"`——即使用户直接问「你是不是不想播了」（ask_core，规则已「允许进入 reveal」）。推进完全依赖 LLM 自觉，截图 / 结局视频在真实模式几乎看不到。
- 修法（导演层保底推进，纯函数 `forcedAdvance`）：规则允许进入下一节点（`advanceRule` 返回「允许进入 X」）后，若 LLM 在本轮没有提出 advance，计一次「已允许未推进」；**连续 2 个真实用户轮**（只数 `source === "user"`，不数 nudge / poke / gift）仍未推进，则服务端在本轮第一个 beat 上强制推进到 X（走 `story.ts` 校验，视觉照节点表）。ask_core / comfort 意图命中 reveal 条件时**当轮**就强制。计数存会话，推进后清零。日志 `story_forced { from, to }`。
- 测试：集成——用「从不输出 advance 的假 LLM」，真实用户输入若干轮后依次到达 probe → reveal → ending（ending 仍需 reveal 后 2 轮）；ask_core 当轮进入 reveal；nudge / poke / gift 不计数。

## §2 第二次换背景失败、原因被掩盖成 aborted（高）
- 现象：日志 `scene_failed { error: "aborted" }`，耗时 62485ms。根因：`adapters/media/imageGen.ts` 的 `DEFAULT_IMAGE_TIMEOUT_MS = 60_000`，单张图超时用 AbortController 中止，被 `runner.ts` 的 `isAbortError` 报成 "aborted"；第二次用 2MB 的生成图当参考图，上传和生成更慢。
- 修法：
  1. 单张图超时 = 任务总预算（`SCENE_TIMEOUT_MS = 90_000`）减去扩写已用时间，至少 30s；不再固定 60s。
  2. 错误分类：`timeout`（单张或总超时）、`session_aborted`（会话中止）、`other_image_failed`（另一张失败连带中止，此时报**第一张失败的真实原因**）、其余原样。`scene_failed` 日志与 `scene_status` 里带分类（不含 Key）。
- 测试：单测——超时 / 会话中止 / 连带中止三种分类；连带中止时报的是先失败那张的原因；单张超时随扩写耗时缩短。

## §3 LLM 网络抖动直接失败、不重试（中）
- 现象：刷新后第一轮 `turn_failed { message: "fetch failed" }`，直接播兜底。
- 修法：在**还没收到任何 token** 时遇到网络类错误（`fetch failed` / ECONNRESET / ETIMEDOUT / 5xx，不含 4xx、不含中止），在首 token 超时预算内重试 1 次；已出过 token 的不重试。日志 `llm_retry`。
- 测试：假 LLM 第一次抛 `fetch failed`、第二次正常 → 本轮正常完成；4xx 与中止不重试；已出 token 后出错不重试。

## §4 动作表：很多项看不出效果（高，用户反馈）
Claude 用脚本在 5181 逐项点击并量化画面变化（眨眼呼吸本身约 1% 像素变化）：
- 明显：飞头 8.6%、身体晃 6.7%、抱熊 3.2%。
- **基本看不出**（放大脸部也看不出）：爱心眼 `ParamLove`、脸黑 `ParamBlack`、黑眼圈 `ParamDark`、哭 `ParamCry`（2.2s 时仍无眼泪）、生气只剩头上小符号。
- **挥手无效**：右手一直握饮料罐不动——`ParamHandR` 不是抬手臂。
- 情绪 6 个里 平静 / 中性 / 惊讶 看起来一样（`toYunaEmotion` 把 surprised、neutral 都映射到 calm）。
修法：
1. **逐参数实测**：写一个只在开发时用的探针（`/?preview=yuna&param=<id>&value=<v>`，扩展现有预览页），把单个参数置为 min / max，导出画布截图到 `e2e/out/param-probe/`（用 Playwright 脚本跑，不打开图片），并用像素差统计（与 value=default 比较）输出一张表到报告：`ParamLove / ParamBlack / ParamDark / ParamCry / ParamTear* / ParamHandR / ParamHandL / ParamHandTurnR / ParamHandHoldR` 等每个参数在 min / max 下的变化百分比。
2. 依据实测：
   - 参数本身有效但被我们的代码覆盖 / 截断（例如舒适区间 `COMFORT_RANGES` 把它截没了、表情参数在 yunaParams 之后被预览合成覆盖为 0）→ 修代码。
   - 参数本身在全身取景下太小 → **表情预览期间镜头临时推近**（复用现有 `close_up` 取景与 600ms 缓动，预览结束拉回），只用于动作表预览，不改对话中的镜头逻辑。
   - 参数确实无效（如挥手没有抬臂参数）→ 从动作表**移除该项**，报告写明原因。
3. 哭的预览时长改为 4s（眼泪曲线 0.58s 开始、2.2s 才流到底）。
4. 情绪组只列画面上可区分的情绪（按实测：平静 / 防备 / 难过 / 温暖，中性与惊讶若与平静无差别则不列）。
5. 表情预览渐出 bug：`previewStore.ts` 的 `composePreview` 在渐出阶段把 `sinceSec` 重置为 `elapsed - hold` 并传 `until = ACCENT_FADE_SEC`，导致权重先跳到 0 再重新渐入；改为在整段时间轴上计算（`sinceSec = elapsed`、`untilSec = hold`）。单测：渐出期间权重单调下降。

## §5 S6u 界面问题（中）
1. 顶栏「02:14:37」是写死的设计稿示意数据——改为从本会话开始计时的真实时长（`HH:MM:SS`，每秒刷新），恢复会话时从会话开始时刻继续（服务端 session 下行补 `startedAt`）。
2. 手机端剧情标题胶囊压住忧奈的头和猫耳——手机端 Live2D 取景整体下移（在 `fitModel` / 舞台布局里给手机竖屏加顶部安全区，等于顶栏 + 标题胶囊的高度），保证头顶不被遮挡；加单测或几何断言（人物包围盒顶部 ≥ 标题胶囊底部）。
3. 手机端「⇅」切换频道按钮删除（D43 只剩忧奈；桌面已删频道栏）；同时去掉上下滑切频道手势（保留点击）。

## §6 smoke 固定走 Mock（低）
- `apps/server/scripts/smoke.ts` 启动服务端时显式 `env: { ...process.env, PROVIDER_MODE: "mock" }`，hello 带 `mode: "mock"`，避免环境里有 `PROVIDER_MODE=real` 时走真实服务。

## §7 e2e 用例修正（「只写不跑」留下的断言错误）
- `e2e/s6l-fix1.spec.ts`：Mock 下换背景用的是 `/characters/yuna/test-scene-*.jpg`，不是 `/generated/`——断言改为「不同于默认背景」并在刷新后仍相同。
- `e2e/s6l.spec.ts` 引导弹幕：断言改为弹幕区包含「你」发出的该句文本（不依赖换行格式）。
- `e2e/s6m.spec.ts`：手机端动作表在菜单抽屉里，按手机路径打开（若 §4 移除挥手，改用摇尾巴）。

## §8 验收
- `pnpm test`、`pnpm typecheck` 全绿；`pnpm smoke` 通过（确认走 Mock）。
- **跑 e2e**：`pnpm e2e -- e2e/s6l-fix1.spec.ts e2e/s6l.spec.ts e2e/s6m.spec.ts`（显式 timeout 1200000），全部通过。
- 报告 `docs/tasks/freeze-fix1-report.md`：每条 → 测试名；§4 的参数实测表与处理结论（修代码 / 推近 / 移除）；未决歧义。

## 关卡 1–5 结论（Claude 决定，均为修复）
1. **YAGNI**：只修已核实问题；§4 依实测决定修 / 推近 / 移除，不新造动作。
2. **端口/适配器**：§3 重试在 LLM 适配器外壳；§2 在生图外壳。
3. **函数式核心**：`forcedAdvance`、错误分类、重试判定、预览权重均为纯函数。
4. **契约式设计**：剧情在真实用户轮数有上界内必然推进；换背景失败原因可读；LLM 只在无 token 时重试一次。
5. **测试奖杯**：每条先失败的单测 / 集成测试；本批跑改动相关的 e2e。
