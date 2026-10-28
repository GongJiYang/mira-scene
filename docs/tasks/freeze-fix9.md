# freeze-fix9 任务说明：录像验收发现的其余问题

> 来源：2026-10-28 正式录像抽帧。执行者：Command Code（deepseek-v4-flash）。冻结期：只修这四条。用户已批准。

## 铁律
冲突停下写进报告，不许绕过；Key 规则见 CLAUDE.md（D49），任何 Key 不得打印；**不准 commit**；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开图片（用像素统计）；长命令显式 timeout；测试不发真实网络请求；**只准停自己启动的进程，禁止 `pkill -f vite` 这类宽匹配**；跑 e2e 必须带 `E2E_SERVER_PORT=8907 E2E_CLIENT_PORT=5294`。**不要改 `Live.tsx` 里输入栏 / 麦克风 / PTT / 声波相关代码、`live.css` 的输入栏部分、`index.html`、`recorder.ts`、`controller.ts`**（freeze-fix8 并行修改中）。先写会失败的测试再改。不改台词。

## §1 动作表「挥手」看不出抬手（中）
- 现象：录像里点「挥手」，右手仍握饮料罐在胸前。freeze-fix1 在 `localActions.ts` / postPhysics 里加了 `ParamBoomR` / `ParamForeamR`，画面无效。
- 要求：先**带噪声对照**地实测（freeze-fix1 的探针只取一次基准、无对照，结论作废）：同一时刻连续取两帧算「静止噪声」差异，再比较参数 min/max 与默认值的差异，只有显著高于噪声才算有效；只统计右臂所在区域（人物包围盒右半上部）。找出真正能抬起右臂的参数组合（含物理输出参数需在物理之后写入）。
- 有效 → 修 `wave` 让右臂明显抬起并摆动；**确实无法抬臂** → 从动作表移除「挥手」（`ActionPanel.tsx` 动作列表与相关 e2e 断言改用摇尾巴），报告写明实测数据。
- 测试：`localActions` 单测；探针数据写进报告（表格：参数、噪声%、min%、max%）。

## §2 开播截图里的人物不是忧奈（中）
- 现象：reveal 时生成的「第一次开播截图」画出了红发黑衣的陌生女生。`characters/yuna/content.json` 的 `imagePrompt` 写了 "no people" 却又描述「girl streamer's first stream」，模型自行画人。
- 修法：生成该截图时**带忧奈参考图**（复用生图模块已有的参考图上传能力，参考图用角色包里已有的忧奈立绘 / 头像资源，选最能代表外观的一张，报告写明），并在角色包 `imagePrompt` 里描述同一人物外观（黑紫双马尾、女仆头饰、猫耳、紫色饮料罐），去掉自相矛盾的 "no people"。文案改动只限这条提示词（英文生图提示词，不是台词）。
- 测试：单测——`buildImagePrompt` 结果含外观关键词、不含 "no people"；生图请求带参考图（假 fetch 断言 multipart 里有参考图）。

## §3 语音输入的识别文字没进弹幕区（低）
- 现象：按住说话识别成功后，弹幕区没有出现用户这句话（文字弹幕会出现）。`danmaku.ts` 有 `transcript` 类型，查明为什么没显示并修复：识别结果应像用户弹幕一样出现在弹幕区（标记来源为语音即可，样式沿用 `user`）。
- 测试：单测（收到当前轮 `transcript` → 弹幕列表新增一条）；旧轮 transcript 不加入（D3）。

## §4 录音脚本音色 bug（低）
- 现象：`apps/server/scripts/record-voices.ts` 用通用 `FISH_VOICE_ID`，不读角色包指定的 `voice.fishVoiceIdEnv`（忧奈为 `FISH_VOICE_ID_YUNA`），`.env` 里通用变量为空时 Fish 回落默认男声（已导致 6 条男声，Claude 已重录）。
- 修法：按角色包 `voice.fishVoiceIdEnv` 取音色；取不到时**报错退出**，不得静默用默认音色。
- 测试：单测（解析音色 ID 的纯函数：有 → 用；无 → 抛错）。**不得实际运行录音脚本。**

## §5 验收与报告
- `pnpm test`、`pnpm typecheck` 全绿，`pnpm smoke` 通过；只在 §1 需要时跑探针 / e2e。
- 报告 `docs/tasks/freeze-fix9-report.md`：每条 → 改动、测试名、§1 实测表、§2 选用的参考图、歧义。

## 关卡 1–5 结论（Claude 决定，修复）
1. YAGNI：只修四条。2. 端口/适配器：§2 在生图适配器与角色包；§4 只动脚本。3. 函数式核心：提示词组装、音色解析、弹幕追加为纯函数。4. 契约：截图人物须带参考图；录音脚本取不到角色音色必须失败。5. 测试奖杯：单测为主，§1 用带噪声对照的探针。
