# S6a 任务说明：忧奈 Live2D 预览 + Command Code LLM 适配器 + S5-fix

> 关卡 1–5 已由用户批准（2026-10-27，见 decisions.md D39）。执行者：Command Code（DeepSeek）。
> 优先级：**① 忧奈 Live2D 预览 → ② Command Code LLM 适配器 → ③ S5-fix**。按这个顺序做，每完成一项跑一次 `pnpm test && pnpm typecheck`。

## 铁律
1. 与本说明、decisions.md 或现有测试冲突时，**停下并在报告里写明**，不许自行改需求，也不许绕过。
2. Key 只从 `.env` 读取，不得打印、写进日志、测试或任何文件。测试里不发真实网络请求。
3. **不准 commit**。不准改 `skills/live2d-auto/*`、`tools/live2d-pipeline/*`（另一个会话的改动）。
4. 改已有测试时只允许改字面值，不许改测试意图；需要改意图的，写进报告的「歧义」一节。
5. 不做任何「额度/余额降级」逻辑（D37）。
6. 不写任何面向用户的文案；需要的占位文字用中性的技术描述（如「模型加载失败：<错误>」）。

## 授权范围
- 新增：`apps/client/src/render/live2d/cubism/**`、`apps/client/src/render/live2d/yuna*.ts`、`apps/client/src/preview/**`、`apps/client/public/models/yuna/**`、`apps/client/public/vendor/cubism/**`、`apps/client/vendor/CubismWebFramework/**`、`apps/server/src/adapters/commandcode/**`、`tools/yuna-assets/**`、对应测试文件、`docs/tasks/s6a-report.md`。
- 可改：`apps/client/src/main.tsx`（只加预览路由分支）、`apps/client/package.json` / tsconfig / vite 配置（为接入框架源码所需）、`apps/server/src/config.ts`、`apps/server/src/index.ts`（只加 provider 选择）、`.env.example`、`apps/server/scripts/smoke-real*`（改成按 provider 走）、S5-fix 涉及的 client `state/storyMedia.ts`、`stage/*`、`view/*` 及其测试。
- 可以联网：只用于下载 Cubism Core 5 和 CubismWebFramework（见 §1.2）。

---

## §1 忧奈 Live2D 预览（`/?preview=yuna`）

### 1.1 资源（`tools/yuna-assets/`）
- 写一个可重复运行的脚本 `tools/yuna-assets/build.sh`（或 python3 标准库 + `sips`），从源目录
  `/Users/gjy/tools/models/yuna/1969791368779464706-2019769674690473986-忧奈_processed.enc/`
  生成到 `apps/client/public/models/yuna/`：
  - 只拷贝：`漠.moc3`、`漠.model3.json`、`漠.physics3.json`、`漠.cdi3.json`、贴图。**不拷贝** exp3、motions、vtube.json、截图（YAGNI，后续批次再加）。
  - 文件全部改成 ASCII 名：`yuna.moc3`、`yuna.model3.json`、`yuna.physics3.json`、`yuna.cdi3.json`、`textures/texture_00.png` …；同步改写 `yuna.model3.json` 里的引用。
  - 贴图只出 **2048×2048** 一个版本（`sips -z 2048 2048`）。64×64 那张原样拷贝。
  - **源目录只读**，不许修改。脚本打印输出目录总大小。
- 水印参数 `Param1`–`Param10` 保持原样，不去掉（D38）。

### 1.2 运行时（Cubism Web SDK 5）
- Cubism Core：从 `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` 下载，放进 `apps/client/public/vendor/cubism/live2dcubismcore.min.js`，同目录放一份许可说明 `LICENSE.md`（写明来源 URL、Live2D Proprietary Software License、下载日期）。页面用 `<script>` 本地加载，**测试和 e2e 不联网**。
- 框架：`git clone --depth 1` 官方 `https://github.com/Live2D/CubismWebFramework`（取最新的 `5-r.*` tag），把源码放进 `apps/client/vendor/CubismWebFramework/`（去掉 `.git`），保留其 LICENSE。通过 vite/tsconfig 别名引用，**不要改框架源码**；类型错误用 tsconfig 的 include/exclude 隔离，不要关掉项目自身的 strict。
- 渲染外壳放在 `apps/client/src/render/live2d/cubism/`：加载 model3.json、moc3、贴图、物理，建一个 WebGL 画布，每帧：取参数 → 写入模型 → 物理 → 更新 → 绘制。**命令式外壳里不写任何决策逻辑**，参数全部来自 §1.3 的纯函数。
- 眨眼可以用框架自带的 `CubismEyeBlink`（参数组 `EyeBlink` 已声明），但眨眼开合值最终要经过 §1.3 的上限。
- **不用** pixi-live2d-display（只支持 Cubism 4 Core）。

### 1.3 纯函数 `yunaParams`（`apps/client/src/render/live2d/yunaParams.ts`）
签名示意：`yunaParams(input: { phase; emotion; mouth; blinkOpen; look?; tSec }) => Record<string, number>`
- 视线和转头必须**先经过现有的 `live2dParams()` / `clampView()`**（params.ts 是唯一出处，不许绕开）。
- **视线 X 取反**：VTube Studio 里 `ParamEyeBallX` 是反向映射（REPORT §4）。在这一层统一取反，并写注释。
- **呼吸**：模型没有 `ParamBreath`。用 `tSec` 驱动的正弦波驱动 `ParamBodyAngleY`（幅度 ≤ 2）和 `ParamAngleY`（幅度 ≤ 1.5），周期约 3.5 秒；speaking 时幅度减半。
- **口型**：`closed/small/open → ParamMouthOpenY = 0 / 0.5 / 1`（沿用 performance.ts 的 `MOUTH_OPEN`）。
- **四种情绪**（参数组合，`neutral` 视同 `calm`）：
  | 情绪 | 参数 |
  |---|---|
  | calm | 不叠加（模型默认脸） |
  | guarded | `ParamEyeLOpen/ROpen` 上限压到 0.6；`ParamBrowLY/RY = -0.4` |
  | sad | `ParamBrowLAngle/RAngle` 设成八字眉方向、`ParamBrowLY/RY = -0.3`、`ParamMouthForm = -0.6` |
  | warm | `ParamMouthForm = 0.7`、`ParamEyeLSmile/RSmile = 0.6`、`ParamShy = 1` |
  具体正负方向请在预览里实测核对，核对结果写进报告；数值放在一张常量表里，便于后续调。
- 情绪切换要平滑：在纯函数外（外壳里）做逐帧插值也可以，但插值本身写成纯函数 `approach(current, target, dt)` 并单测。
- **后置条件**：输出的每个参数都在舒适区间内：`ParamAngle*` ∈ [-30,30]、`ParamBodyAngle*` ∈ [-10,10]、`ParamEyeBall*` ∈ [-1,1]、`ParamEyeL/ROpen` ∈ [0,1.9]、`ParamMouthOpenY` ∈ [0,2.1]、`ParamMouthForm` ∈ [-1,1]、其余 ∈ [-1,1] 或 [0,1]。用 **fast-check** 写属性测试：任意 phase/emotion/mouth/blink/look/tSec 输入，输出都满足上面的区间，且不出现 NaN。

### 1.4 预览页（`apps/client/src/preview/YunaPreview.tsx`）
- `main.tsx` 里：URL 带 `?preview=yuna` 时渲染预览页，否则照旧渲染现有 App。
- 页面：左边画布显示忧奈（大约胸像到大腿的构图，居中），右边一个调试面板：phase（idle/listening/thinking/speaking）、emotion（calm/guarded/sad/warm）、mouth（closed/small/open + 「自动说话」开关，按随机节奏切口型）、手动眨眼按钮；面板上显示 FPS 和贴图尺寸。
- 模型加载失败：画布位置显示一张错误卡片「模型加载失败：<错误信息>」，**不**回退到夏凛。

---

## §2 Command Code LLM 适配器（`apps/server/src/adapters/commandcode/`）
背景：DeepSeek 账户余额为 0，用户决定先用 Command Code 的额度（D39）。实测 `cmd -p … --output-format json` 输出 NDJSON，回复文字在 `{"type":"event","event":{"type":"text_delta","delta":"…"}}` 里，最后一行 `{"type":"result","subtype":"success",…}`。

- 实现现有 `LLMPort`（`streamBeats`），**核心和会话层一行不改**。
- 纯函数：
  - `flattenMessages(messages: ChatMessage[]) => string`：把 `renderPrompt` 产出的 system/user/assistant 消息拼成一条 prompt（每段标出角色），并在最前面写明「你不是编程助手，不调用任何工具，只按下面的格式输出」。
  - `parseCmdNdjson`：增量解析 NDJSON 行，产出 `text_delta` 文本；`result.subtype !== "success"` 或出现错误事件时给出错误；坏行忽略。
  - 文本再交给现有的 `parseBeatLines` 产出 beat，与 DeepSeek 适配器同一路径。
- 外壳：用注入的 `spawn`（默认 `node:child_process`）启动
  `cmd -p <prompt> -m <model> --effort off --skip-onboarding --trust --no-session --no-skills --max-turns 1 --output-format json`，
  `stdin` 关闭，`cwd` 用一个空的临时目录（不要让它读到仓库）。模型默认 `deepseek/deepseek-v4-flash`，可用 `COMMANDCODE_MODEL` 覆盖。
- 配置：`LLM_PROVIDER=commandcode|deepseek`（默认 `deepseek`，保持现有行为），写进 `config.ts` 和 `.env.example`。`PROVIDER_MODE=mock` 时不受影响。
- 契约：
  - 启动时（`LLM_PROVIDER=commandcode` 且非 mock）检查 `cmd` 可执行且 `cmd status` 显示已登录；不满足就**启动报错退出**，给出清楚的提示。
  - 一轮中途子进程非零退出或 result 不是 success：抛错，走现有 `turn_failed`。
  - 收到 AbortSignal：立刻 `kill` 子进程，迭代器立即结束（和 DeepSeek 适配器的中止语义一致）。
  - 日志沿用现有 logger：记录 `prompt_version`、耗时、usage（只记数字）。
- `pnpm smoke:real`：按 `LLM_PROVIDER` 走对应适配器。验收时由 Claude 亲自跑，你可以跑一次确认能通，报告里贴首句延迟。

## §3 S5-fix（见 decisions.md D37 末尾、s5-report §已知问题）
1. **ending 不再出现空白相纸**：ending 轮的 `media.type === "video"` 在 `media_ready` 之前不显示任何占位（空白相纸只属于照片显影流程）；视频就绪后直接淡入。
2. **reveal 的照片保留**：视频不再占用照片的槽位。照片和视频各自一个槽位；视频播放期间盖在上层，播完淡出后 reveal 的照片仍在。打断时照片保留、视频结束（D37）不变。
- 用 reducer 单测覆盖这两条，必要时补一条 e2e 断言。

---

## §4 测试要求（测试奖杯）
- 单测：`yunaParams`（含 fast-check 属性测试）、`approach`、`flattenMessages`、`parseCmdNdjson`、S5-fix 的 reducer。
- 集成：commandcode 适配器注入假 `spawn`（假 stdout 逐行吐 NDJSON），验证：beat 流式产出、坏行降级、非零退出抛错、中止时调用了 kill 且迭代器结束。
- e2e（Playwright）：打开 `/?preview=yuna`，画布出现、3 秒内没有 console error、切换 emotion 不报错。Core 和模型都是本地文件，不联网。
- 全部通过：`pnpm test`、`pnpm typecheck`、`pnpm smoke`、`pnpm e2e`。

## §5 报告（`docs/tasks/s6a-report.md`）
写明：改了哪些文件；资源大小（改动前 48.7 MiB → 改动后多少）；Cubism 框架 tag 号；情绪参数正负方向的实测结论；cmd 适配器的首句延迟实测；测试数；遇到的歧义和你的处理（Claude 会裁定）。

## 引用
Q10（Mock 完整运行）、D28、D34、D36、D37、D38、D39；`/Users/gjy/tools/models/yuna/REPORT.md`。
