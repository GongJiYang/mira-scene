# S6c-fix1 任务说明：换背景旁路的正确性修复

> 来源：Claude 对 S6c 核心代码的第二道审查（`/code-review high`，2026-10-28），以下问题均已由 Claude 对照代码核实。执行者：Command Code（deepseek-v4-flash）。在 S6g-A 合并之后的 main 上做。
> 关卡 1–5 结论见末尾。

## 铁律
冲突停下写进报告；台词和提示词原样使用；Key 只从 `.env` 读取、不得打印；不准 commit；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片；长命令显式传大 timeout，同一命令超时两次就停下写进报告；测试里不发真实网络请求。**每一条修复都必须先写一个会失败的测试复现问题，再改代码让它通过**（报告里列出测试名）。

## §1 冷却 / 超次数 / 忙：序号冲突吞掉真实回复（严重）
- 现状：`session.ts` 拒绝换背景时发 `busyBeat{seq:0}`，随后 LLM 第一句也是 `seq:0`；客户端 `reducer.ts` 按 seq 去重，把 LLM 的真实第一句丢掉。
- 修法：busy 兜底句必须走本轮的 seq 分配器（占用下一个 seq，LLM 的 beat 顺延），不再硬编码 0。
- 同时：`scene_notes` 只能在**准入通过后**才写「对方想换个背景，你这边正在换」；被拒时改写为「对方想换背景，但现在换不了（原因：上一个还没换完 / 刚换过要等一会 / 今晚次数用完）」，让 LLM 的回话和兜底句不矛盾。原因文本放进角色包或常量，**不要新写台词**。

## §2 异步失败 / 拒绝的兜底句被当成过期消息丢掉（严重）
- 现状：失败可能在 45–90 秒后才发生，此时用户可能已经发了新一轮；兜底 beat 仍用发起轮次的 turnId 且 `seq:0`，被客户端按 turnId 过滤丢掉，或和当前轮 seq 冲突。
- 修法：失败 / 拒绝**不再发轮次 beat**，改成剧情层（同 D27 的 `media_ready`）：`scene_status` 的 `failed / rejected` 载荷带 `category`（`scene_failed` / `scene_rejected`）；客户端收到后，在角色**不说话**的空档（idle / listening）播放本地预录兜底音频并显示这句字幕；正在说话就排队等这轮结束；被打断不作废。另外下一轮的 `scene_notes` 加一句「刚才背景没换成」，让 LLM 可以自然提及。
- 预录音频路径沿用 `apps/client/public/characters/<id>/voice/fallback/<category>.mp3`（Claude 会用 Fish 合成这三条，文件不存在时只显示字幕，不报错）。

## §3 90 秒超时没有真正生效（严重）
- 现状：`runner.ts` 只在 `Promise.all` 结束后比较耗时；扩写或生图挂住时任务永远停在 writing / generating，之后整场都返回 busy。
- 修法：每个任务一个 `AbortController`，与会话的 `sceneController` 联动；`SCENE_TIMEOUT_MS` 到点即 abort（扩写和两张生图一起取消）→ `failed`。两张图任何一张失败，立即 abort 另一张（不再白白付费）。

## §4 会话生命周期
- `sceneController` 在会话解绑时 abort，但**恢复会话时没有重建**，之后每次换背景立即失败并扣次数 → 恢复会话时新建。
- 会话过期清理（sweep）和 `dispose()` 也要 abort 进行中的换背景任务。

## §5 imageGen 适配器
- `generations` 路径在调用方没传 `size` 时**不要带 size**（恢复 S6b 剧情照片的原行为）。
- `edits` 路径上传参考图：按扩展名设置 MIME（`image/jpeg` / `image/png` / `image/webp`），文件名用真实扩展名。

## §6 扩写器 `scene/writer.ts`
- 所有把用户文字代入模板的 `.replace` 改为函数替换（`() => text`），避免 `$'`、`$&` 被展开。加单测：用户输入含 `$'` `$&` `$$`。
- 复用已有的提示词解析（`prompts/loader.ts` 的 `parsePromptFile`）和已有 LLM 适配器，删掉重复实现；提示词文件每次调用只读一次。commandcode 分支出错时必须结束子进程（直接复用 `adapters/commandcode` 的实现即可）。
- 去掉 `session.sceneWriter!` / `sceneImageGen!` 非空断言：缺依赖时准入直接拒绝并打日志。

## §7 参考图与当前场景
- 参考图应为**当前正在显示的背景**（上一次换成功的生成图，否则角色包默认背景），会话里记录当前背景的本地路径。
- `currentScene` 传当前背景的描述（上次成功的 label，否则角色包默认场景描述），不是剧情节点 id。

## §8 清理
`runner.ts` 里未使用的局部 `state`、永不返回的 `busy` 结果、直通包装 `admitScene` 删掉。

## §8b 顺带修的 4 个界面问题（S6g-A 遗留）
1. **ending 时截图卡片没收起**：进入 ending（OFFLINE 视频）时收起截图卡片，不能叠在视频上。加单测或 e2e 断言。
2. **「平静」情绪猫耳朵消失**（「防备」正常）：查 S6g-A 删耳朵动作后 `ParamEarOFF` / 耳朵相关参数是否被写成隐藏值；平静时耳朵必须可见。加 `live2dParams` 单测覆盖四种情绪下耳朵参数。
3. **「温暖」情绪 e2e 截图被 ending 视频挡住**：e2e 改为在 ending 视频出现之前截图。
4. **文档页手机横向溢出 6px**（`e2e/docs.spec.ts` 失败）：疑为 `docs/architecture/00-导读.md` 的宽代码块；代码块在卡片内横向滚动（`overflow-x: auto`，`max-width: 100%`），页面本身不能横向溢出。`e2e/docs.spec.ts` 必须通过。
- 不要改输入框占位文字「‹输入框占位›」。

## §9 测试
`pnpm test`、`pnpm typecheck` 全绿；e2e 换背景用例、`e2e/docs.spec.ts` 通过；报告列出每条修复对应的新测试。

## §10 报告 `docs/tasks/s6c-fix1-report.md`

## 关卡 1–5 结论（Claude 决定）
1. **YAGNI**：只修正确性，不加新功能；删掉重复实现和死代码。
2. **端口/适配器**：扩写器复用现有 LLM 适配器，不再自己 spawn。
3. **函数式核心**：准入、超时判定仍是纯函数；取消由外壳的 AbortController 负责。
4. **契约式设计**：后置条件——旁路发出的任何消息都不会让当前轮次的 beat 被丢弃；失败兜底属于剧情层，不受 turnId 过滤；任务最长 90 秒必然结束。
5. **测试奖杯**：每条修复先写失败的集成测试再改。
