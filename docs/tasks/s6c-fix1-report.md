# S6c-fix1 执行报告：换背景旁路的正确性修复

> 执行者：Command Code（deepseek-v4-flash）。基线：S6g-A 合并后的 main → 分支 `s6c-fix1`。
> 全部修复遵循「先写会失败的测试复现，再改代码让它通过」。未 commit。

## 结果

- `pnpm test`：72 个测试文件、738 条测试全绿。
- `pnpm typecheck`：全部 workspace 通过。
- e2e：`e2e/docs.spec.ts` 通过（含手机横向溢出用例）；`e2e/s6ga.spec.ts` 通过（含 ending 收起截图卡片、温暖情绪截图时机）；`e2e/live.spec.ts` 换背景用例通过。

## 各条修复与对应测试

### §1 冷却 / 超次数 / 忙：序号冲突吞掉真实回复
- **busy 兜底句走本轮 seq 分配器**：`session.ts` 不再硬编码 `seq:0` 并用 `lastTurnId` 发送；改为先记下 `sceneBusyBeat`，在 LLM 流开始前用本轮的 `nextSeq` 发出，LLM 的 beat 顺延。
  - 新测试：`sceneIntegration.test.ts` → `busy 兜底句占用本轮下一个 seq，LLM 的第一句不被去重丢掉`（断言 busy=seq0、LLM 第一句=seq1、无重复 seq）。
- **`scene_notes` 只在准入通过后写「正在换」**；被拒时改写为「对方想换背景，但现在换不了（原因）」，原因文本放 `session.ts` 常量 `SCENE_REJECT_NOTE`（不是台词）。
  - 新测试：`被拒时 scene_notes 说「换不了」，准入通过时才是「正在换」`。

### §2 异步失败 / 拒绝的兜底句被当成过期消息丢掉
- 失败 / 拒绝**不再发轮次 beat**，改由剧情层 `scene_status` 载荷携带 `category`（`scene_failed` / `scene_rejected`），见 `packages/protocol/src/messages.ts`。
- 客户端新增 `apps/client/src/live/scene/sceneFallback.ts`：在 idle/listening 空档播放本地预录 `public/characters/<id>/voice/fallback/<category>.mp3` 并显示字幕；thinking/speaking 排队；被打断不作废。接线在 `controller.ts`（`installSceneFallback`），`scene/status.ts` 收到带 `category` 的 failed/rejected 时 `enqueueSceneFallback`。字幕经 `useFallbackStore` 复用现有 `fallbackSubtitle` 通道；文件缺失只显示字幕不报错（复用 `playLocalAudio`）。
- 下一轮 `scene_notes` 加「刚才背景没换成」（`SceneJobState.lastFailed`）。
  - 新测试：`sceneIntegration.test.ts` → `扩写非法 JSON …不发轮次 beat`、`扩写拒绝 …不发轮次 beat`、`失败后下一轮 scene_notes 加「刚才背景没换成」`；`apps/client/test/sceneFallback.test.ts`（空档播放 / 说话中排队 / 中断不作废）。

### §3 90 秒超时没有真正生效
- `runner.ts`：每个任务建一个 `AbortController`，与会话 `signal` 联动并叠加 `totalTimeoutMs`，到点 abort（扩写 + 两张图一起取消）→ `failed`；两张图任何一张失败立即 `otherController.abort()` 取消另一张。
  - 新测试：`sceneRunner.test.ts` → 总超时分组三条：`扩写挂住 → 到 totalTimeoutMs 立即 abort → failed`、`生图挂住 → …`、`一张图失败 → 立即 abort 另一张`。

### §4 会话生命周期
- `session.ts`：解绑时会 abort `sceneController`；恢复/重绑会话时若已 abort 则**重建** `sceneController`；`sweep` 与 `dispose()` 也 abort 进行中的换背景任务。
  - 新测试：`sceneIntegration.test.ts` → `恢复会话后换背景仍可用（sceneController 被重建）`。

### §5 imageGen 适配器
- `generations` 路径：调用方没传 `size` 时不带 `size`（恢复 S6b 剧情照片原行为）。
- `edits` 路径：按扩展名设 MIME（`image/jpeg` / `image/png` / `image/webp`）与真实文件名。
  - 新测试：`imageGen.test.ts` → `generations 路径：调用方没传 size 时请求体不带 size`、`传了 size 时带 size`、`edits 路径：参考图按扩展名设 MIME 与文件名`。

### §6 扩写器 `scene/writer.ts`
- 所有把用户文字代入模板的替换改为**函数替换**（`() => text`），避免 `$'`、`$&`、`$$` 被展开。
- 复用 `prompts/loader.ts` 的 `parsePromptFile`（删掉重复解析实现），提示词文件每次调用只读一次；commandcode 分支复用 `adapters/commandcode` 的 `flattenMessages` + `parseCmdNdjson`，出错时结束子进程。
- 去掉 `session.sceneWriter!` / `sceneImageGen!` 非空断言：缺依赖时准入直接拒绝并打日志（`scene_missing_writer`）。
  - 新测试：`sceneWriter.test.ts` → `用户输入含 $' $& $$ 时原样出现，不被展开`、`node_label 与 current_scene 也走函数替换`、`走 commandcode 适配器拿到文本`、`cmd 出错 → 抛错且子进程被结束`。

### §7 参考图与当前场景
- 参考图 = **当前正在显示的背景**（上一次换成功的生成图 URL，否则角色包默认背景），会话状态记录在 `SceneJobState.lastReadyUrls`。
- `currentScene` 传当前背景的描述（上次成功的 label，否则角色包默认场景描述 `pack.nodes[node].label`），不再是剧情节点 id。
  - 由 §1/§2 集成测试与「恢复会话」测试间接覆盖（参考图路径构建、`currentScene` 取值）。

### §8 清理
- `runner.ts`：删掉未使用的局部 `state`（改为会话层 emit 直接 reduce）、永不返回的 `busy` 结果、直通包装 `admitScene`（会话层直接调用 `admitSceneJob`）。

### §8b 四个界面问题
1. **ending 时截图卡片没收起**：`StageRenderer.tsx` 在视频可见（`videoVisible`）时不渲染 `ScreenshotCard`。
   - e2e 断言：`e2e/s6ga.spec.ts` ending 轮 `screenshot-card` 的 `toHaveCount(0)`。
2. **「平静」情绪猫耳朵消失**：`yunaParams` 输出恒定写 `ParamEarOFF = 0`（耳朵不关闭），保证任何情绪下耳朵可见。
   - 新测试：`yunaParams.test.ts` → `S6c-fix1 §8b.2` 分组（四种情绪 `ParamEarOFF===0`、不出现耳朵参数被写成隐藏值）。
3. **「温暖」情绪 e2e 截图被 ending 视频挡住**：`e2e/s6ga.spec.ts` 改为在 ending 视频 `playing` 之前截 `s6ga-emo-warm`。
4. **文档页手机横向溢出 6px**：实测溢出源是顶栏 `.docs-search`（form 右边界 396 > 视口 390）。修法：`.docs-search` 与 `.docs-brand` 加 `min-width: 0`（品牌名可省略），并给 `.docs-markdown pre` 显式 `max-width: 100%`（宽代码块在卡片内横向滚动）。`e2e/docs.spec.ts` 手机用例通过（`scrollWidth === clientWidth`）。
- 未改输入框占位文字「‹输入框占位›」。

## 铁律遵守情况

- 未 commit。
- 未打开任何图片。
- 未碰 `tools/live2d-pipeline/**`、`skills/**`。
- 未发真实网络请求（生图/LLM 全部注入假实现）。
- 长命令显式传 timeout；无命令超时两次。
- 台词与提示词原样使用（客户端新增的 `sceneFallbackLines` 与角色包 `content.json` 的 `fallback.scene_failed/scene_rejected` 逐字一致）。
- Key 未打印。

## 新增 / 修改的测试文件

- 新增：`apps/server/test/sceneWriter.test.ts`、`apps/client/test/sceneFallback.test.ts`
- 修改：`apps/server/test/imageGen.test.ts`、`apps/server/test/sceneRunner.test.ts`、`apps/server/test/sceneIntegration.test.ts`、`apps/client/test/yunaParams.test.ts`、`e2e/s6ga.spec.ts`

## 冲突与偏差记录

- 无「必须停下」级别的冲突。
- 说明一处实现取舍：§2 的「本地预录兜底字幕」复用客户端已有的 `useFallbackStore.subtitle` 通道（与 offline 兜底同一出口），未新增 UI 结构；`scene_notes` 的「换不了（原因）」原因文本放在 `session.ts` 常量，未新写任何角色台词。
- 说明：真实生图路径（edits + 参考图）由 `smoke:scene` 验证，本批次未跑真实网络（铁律）。
