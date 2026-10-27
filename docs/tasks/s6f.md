# S6f 任务说明：隐藏夏凛 + 忧奈四态动作

> 用户 2026-10-28 授权「直接让 Kimi 去跑」。关卡 1–5 结论由 Claude 决定（见末尾），执行者：Command Code（Kimi-K3）。
> 与 S6c（弹幕换背景，另一个 worktree）并行，两边都可能改 `characters/*/pack.json`、`pack.ts`、`Live.tsx`：**只做本说明列出的最小改动**，方便合并。

## 铁律
冲突停下写进报告；台词和提示词原样使用；Key 只从 `.env` 读取、不得打印；不准 commit；不做余额降级；不碰 `tools/live2d-pipeline/**`、`skills/**`；不要用读文件工具打开任何图片；长命令显式传大 timeout，同一命令超时两次就停下写进报告。

## 授权范围
`characters/rin/pack.json`（只加 `hidden`）、`apps/server/src/characters/pack.ts`、`apps/server/src/index.ts`、`apps/server/src/config.ts`（只为隐藏角色跳过音色校验）、`apps/server/scripts/smoke-real.ts`、客户端频道列表与默认频道、`apps/client/src/render/live2d/**`、`apps/client/public/models/yuna/expressions/**`、`apps/client/public/models/yuna/motions/**`、直播间 UI（只加倾听声波和思考提示）、对应测试、e2e、`docs/tasks/s6f-report.md`。

## §1 隐藏夏凛（不删除）
- `pack.json` 加可选字段 `"hidden": boolean`（缺省 false），夏凛设为 `true`。素材、台词、测试数据一律保留。
- 服务端：隐藏角色**不出现在频道列表**；连接请求指定隐藏角色 → 按现有 `unknown_character` 处理（不回退）。
- 缺省角色改为第一个未隐藏的角色（现在是 `yuna`）；不要再写死 `"rin"`。
- 真实模式：隐藏角色的 `fishVoiceIdEnv` **不做必填校验**（现在 `FISH_VOICE_ID` 为空会让 `pnpm smoke:real` 启动失败）。`smoke:real` 只跑未隐藏的角色。
- 客户端：频道栏 / 手机上下滑只剩忧奈；只有一个频道时隐藏切换栏或保持单项都可以，布局不能空一块。
- 测试里依赖夏凛的用例：改成显式加载隐藏包，或改用忧奈；不要删测试来变绿。

## §2 忧奈四态动作（题目：待机、倾听、思考、说话，关掉声音也能分辨）
现状：倾听和待机在人物身上完全一样，只有麦克风图标亮——这是本批要解决的核心问题。

素材来源 `/Users/gjy/tools/models/yuna/`（正版商用皮套，参数说明见该目录 `REPORT.md`）：14 个 `*.exp3.json`、`motions/流泪.motion3.json`（若该目录下没有 motions，以 `漠.vtube.json` 里的路径为准，找不到就写进报告）、参数表 `漠.cdi3.json`。需要的 exp3 / motion 复制到 `apps/client/public/models/yuna/expressions|motions/`，文件名改成英文（如 `cry.exp3.json`）。

**做法：仍然是纯函数出参数**。扩展 `yunaParams.ts`（或新建同目录纯函数），输入 `{ phase, emotion, mouth, blinkOpen, tSec, phaseSinceSec, idleSinceSec, silentAction? }`，输出这一帧全部参数。exp3 的开关值直接读进常量表（不需要 SDK 的表情管理器）；流泪 motion 若能用 SDK 播就播，不能就把它的曲线采样进纯函数。视线 / 转头仍必经 `live2dParams()` / `clampView()`（D36）。

| 状态 | 人物表现（要求） |
|---|---|
| 待机 idle | 呼吸 + 眨眼 + 视线缓慢漂移（幅度小）；`idleSinceSec > 8` 后每 8–14 秒随机一个小动作（抱熊 `ParamPet` 3–5 秒、视线看向一侧再回来、耳朵相关参数轻动，参数名以 cdi3 为准），随机数由调用方传种子，纯函数可测 |
| 倾听 listening | 进入后 300ms 内过渡到：身体前倾（`ParamBodyAngle*`/`ParamAngleY` 等，以 cdi3 为准）、头微歪 `ParamAngleZ` 约 6°、眼睛开到最大、看镜头；每 2–3 秒一次轻微点头（`ParamAngleY` 小幅下上）。UI：麦克风旁加随输入音量跳动的声波（文字输入时也显示「正在听」） |
| 思考 thinking | 保留现有视线偏开；加头歪向另一侧、眨眼变慢；字幕区出现「……」三点动画（不是聊天气泡，不改字幕区结构） |
| 说话 speaking | 现有口型 + 情绪；新增表情叠加：`sad` → 哭哭（`ParamCry`）+ 流泪；`warm` → 现有脸红；本会话**第一句**回话开始时叠加惊讶（`ParamAmazed`）1.2 秒 |

`silentAction`（`content.json` 的 `drink / phone / show_item / glance`）现在若未在忧奈身上表现，按下面映射：`drink` → 低头 + 闭眼 1 秒；`phone` → 视线向下 2 秒；`show_item` → 抱熊 3 秒；`glance` → 看向一侧 1.5 秒。

**禁止**：飞头（`ParamFlyHead*`）、飞宠（`ParamFlyPet`）、脸黑（`ParamBlack`）、黑眼圈（`ParamDark`）、生气（`ParamAngry`）在任何输入下都必须为 0；**水印 / 授权文字参数 `Param1`–`Param10` 任何输入下都必须为 0**。

## §3 测试（测试奖杯：纯函数单测为主，e2e 兜住整体）
- 单测：四个状态各自的关键参数（倾听 ≠ 待机：至少 `ParamAngleZ` 与身体前倾不同）；状态切换 300ms 过渡；第一句惊讶只出现一次；`silentAction` 映射。
- fast-check 属性测试：任意 `phase / emotion / tSec / silentAction / 种子` → 禁止参数与 `Param1`–`Param10` 恒为 0，视线 / 转头不超过 `VIEW_LIMITS`。
- e2e（`E2E_SERVER_PORT=8987 E2E_CLIENT_PORT=5373`）：只看得到一个频道；四个状态各截一张图存 `e2e/out/s6f-<phase>.png`（你不用看图，Claude 会看），并断言 Live2D 画布非空。
- `pnpm test`、`pnpm typecheck` 全绿；`pnpm smoke:real` 跑一次（DeepSeek 已充值、`PROVIDER_MODE=real`），把首句耗时和是否成功写进报告；失败如实写，不写降级。

## §4 报告 `docs/tasks/s6f-report.md`
改了哪些文件、每个状态最终用了哪些参数和数值、cdi3 里找不到的参数、测试结果、smoke:real 结果、和 S6c 可能冲突的文件清单。

## 关卡 1–5 结论（Claude 决定）
1. **YAGNI**：夏凛用 `hidden` 开关隐藏，不删素材、不做通用插件；动作用常量表 + 纯函数，不做动作引擎或时间线编辑器。
2. **端口/适配器**：不加新端口；改动只在渲染层和角色包加载。
3. **函数式核心**：每帧参数由纯函数产出（时间、随机种子由调用方传入），渲染器只负责写参数。
4. **契约式设计**：后置条件——禁止参数和水印参数恒为 0、视线不超限；前置条件——隐藏角色不可连接、缺省角色必为未隐藏。
5. **测试奖杯**：纯函数单测 + 属性测试为主，e2e 只验整体可见与截图。
