# S6g-A 任务说明：忧奈舞台补齐题目 §4/§5 + 删夏凛 + 表演修正 + 入口按钮

> 用户 2026-10-28 授权 Claude 直接派发。关卡 1–5 结论见末尾。执行者：Command Code（deepseek-v4-flash）。
> 背景决策：D43（删夏凛）、D44（ending 视频，透明版留到 S6g-B）、D46①（眉毛写物理输入）、D27（剧情媒体不随轮次作废）、D34（打断矩阵）。先读 `docs/architecture/decisions.md` 这几条和 `docs/architecture/00-导读.md` 的 §4/§5。

## 铁律
冲突停下写进报告；台词和提示词原样使用（**本批不新增任何台词或界面文案以外的文字**，界面文字放 `uiText.ts`）；Key 只从 `.env` 读取、不得打印；不准 commit；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片（截图只落盘，Claude 看）；长命令显式传大 timeout，同一命令超时两次就停下写进报告；测试里不发真实网络请求。

## §1 删除夏凛（D43）
- 删除 `characters/rin/`、`assets/voice/rin/`、`apps/client/public/characters/rin/`、`assets/raw/`、`assets/parts/`、`apps/client/public/stage/`（先 grep 确认只被夏凛用）。
- 删除**只服务夏凛的代码**：分层立绘渲染（`stage/layers.ts`、`view/Stage.tsx`、`LayeredStage`、`composeStage`、`charClip.ts`、雨 `rain.ts`/`RainCanvas.tsx`、拍立得 `develop.ts`/`photoRect.ts` 等——**以 grep 结果为准**，被忧奈或 Live2D 路径用到的保留；`StoryVideo.tsx` 若可复用给忧奈就保留并改造）。`renderer.kind` 只剩 `live2d`。
- 删除 S6f 加的 `hidden` 字段及相关分支、测试辅助 `testPacksWithRinVisible`；依赖夏凛的测试改为忧奈或删除**只测夏凛素材**的用例（报告里逐个列出删了哪些、为什么）。
- 导演层里写死的 `rain_heavy` / `rain_stop` / `warm_glow` / `photo_letters` / `clip_ending` 改为由 §2 的角色包配置提供。
- protocol 枚举里只属于夏凛的值（如雨、`polaroid` 手部）若删除会牵连太广，可以保留但不再使用，报告说明。

## §2 剧情节点视觉搬进角色包
- `characters/yuna/pack.json` 新增 `nodes`：
  ```json
  "nodes": {
    "arrive": { "fx": null },
    "reveal": { "camera": "close_up", "fx": "stream_dim", "media": { "type": "photo", "id": "photo_first_stream" }, "action": "show_item" },
    "ending": { "camera": "wide", "fx": "hearts", "media": { "type": "video", "id": "clip_offline" } }
  }
  ```
- protocol `fxSchema` 增加 `stream_dim`、`hearts`（保留旧值不破坏解析）。导演层（纯函数）从 `ctx.pack.nodes[node]` 取镜头 / 特效 / 媒体 / 强制动作；缺字段即不下发。导演层属性测试保持：任意 LLM 输出都不会产生角色包里没有的 fx / media id。

## §3 Live2D 舞台补渲染（核心）
`StageRenderer` 的 live2d 分支现在只接了 phase / emotion / performance / background，**镜头、特效、剧情媒体都没接**。补上：
1. **镜头**：`close_up` → Live2D 画布容器 600ms 缓动推近到半身（脸在画面上 1/3 处），`wide` / null → 回全身。纯函数 `cameraFor(camera, orientation)` 出 `{scale, tx, ty}`，桌面/手机各一组，有单测。
2. **特效**：`stream_dim` → 舞台叠一层 40% 暗色 + 背景灯光变暗（CSS），弹幕区不受影响；`hearts` → 写 `ParamHeart=1`（皮套爱心漂浮，0.4s 渐入）+ 舞台暖色光晕层。特效随剧情节点保持，打断不撤销（属于剧情层）。
3. **reveal 截图弹窗**：直播间里弹出一个「截图」卡片（不是聊天气泡），覆盖舞台一角：生成中 → 卡片内显示加载状态；`media_ready status=ready` → 显示生成图；`fallback` 或失败 → 显示预置 `/characters/yuna/photo_first_stream.png`，**不提示错误**。打断不撤销弹窗（D27）。卡片可点关闭。
4. **ending 视频**：`clip_offline` 叠在舞台上播放（本批仍是现有不透明片段，透明版在 S6g-B）：进入 ending 即预加载；加载中不黑屏（先保持舞台）；播完停在最后一帧；用户按说话键打断 → 200ms 淡出暂停、回倾听；加载失败 → 不显示视频、保持舞台，不报错。
5. 手机和桌面两种布局都要做。

## §4 表演修正
1. **眉毛（D46①）**：`ParamBrowLAngle/LY/RAngle/RY` 是物理输出，会被覆盖。查 `yuna.physics3.json` 里 `ParamBrowL/R` → 输出的映射，把 `EMOTION_PARAMS` 里的眉毛改成写 `ParamBrowL/R`（物理输入），使 guarded / sad 的眉形真正生效。报告写清映射与最终数值。
2. **耳朵**：S6f 的耳朵轻动写的是物理输出 `ParamEarsLX1/RX1`，无效 → 从待机小动作里删掉。
3. **抱熊（用户反馈突兀）**：从待机随机小动作里删掉；只在 `silentAction=show_item` 时出现；`ParamPet` 0→1 用 0.6s 线性渐变、结束时 1→0 渐变。e2e 截一张渐变中间帧 `e2e/out/s6ga-pet-mid.png`。
4. S6f 遗留：待机瞟眼和 `glance` 的视线必须经 `clampView()`；禁止参数清零挪到函数最后一步（属性测试不变）。
5. `sceneJobReducer` 的 `failed` 只在 `writing / generating` 状态下生效（已 ready 的任务不能被迟到的超时改成 failed），补单测。

## §5 入口按钮（用户要求）
直播间首页 `/` 加「文档」「观测」两个入口：桌面放顶栏右侧，手机放在可展开的菜单里；分别跳 `?docs=1`（默认打开 `docs/architecture/00-导读.md`，若文档窗口支持按路径打开就带上）和 `?obs=1`。文字放 `uiText.ts`。

## §6 观测页
瀑布条改为**所有行用同一时间刻度**（取最近 20 轮里最长的一轮为满宽），便于比较快慢。

## §7 测试
- `pnpm test`、`pnpm typecheck` 全绿；`director.property.test.ts` 若仍偶发失败，固定 seed 或放宽到稳定（报告说明）。
- e2e（`E2E_SERVER_PORT=8987 E2E_CLIENT_PORT=5373`，被占用就换并写进报告），Mock 模式走 arrive → reveal → ending，截图：`s6ga-arrive.png`、`s6ga-reveal.png`（推近 + 变暗 + 截图弹窗）、`s6ga-ending.png`（拉远 + 爱心 + 视频）、手机各一张 `-mobile`；四种情绪各一张 `s6ga-emo-<calm|guarded|sad|warm>.png`；入口按钮可见并能跳转。断言 Live2D 画布非空。
- 全量 e2e 跑一次，报告通过/跳过数。

## §8 报告 `docs/tasks/s6g-a-report.md`
删了哪些文件 / 测试（逐个列）、`nodes` 配置、镜头和特效的数值、眉毛物理映射、测试结果、遗留问题。

## 关卡 1–5 结论（Claude 决定）
1. **YAGNI**：夏凛整体删除，不留兼容层；剧情视觉配置只做 `nodes` 一张表，不做通用时间线编辑器；透明视频、缓存留到 S6g-B。
2. **端口/适配器**：不加新端口；媒体仍走现有 `MediaPort`。
3. **函数式核心**：导演层读角色包仍是纯函数；镜头变换 `cameraFor` 纯函数；Live2D 参数仍由 `yunaParams` 纯函数产出。
4. **契约式设计**：导演层后置条件——fx / media 只能来自角色包；`Param1`–`Param10` 恒为 0；剧情层（截图弹窗、特效）不随轮次作废，台词 / 动作仍严格按 turnId 作废。
5. **测试奖杯**：纯函数单测 + 导演层属性测试为主，e2e 走一遍剧情并截图。
