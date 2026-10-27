# S6b 任务说明：角色包 + 直播间 UI v1 + 忧奈接入正式舞台 + 情景化兜底 + 语音包清单

> 关卡 1–5 已由用户批准（2026-10-27，decisions.md D40）。执行者：Command Code（DeepSeek）。
> 顺序：**§1 角色包 → §2 情景化兜底 → §3 忧奈接入舞台 → §4 直播间 UI → §5 语音包清单**。每完成一节跑 `pnpm test && pnpm typecheck`。

## 铁律
1. 与本说明、decisions.md 或现有测试冲突时，**停下并写进报告**，不许自行改需求，也不许绕过。
2. Key 只从 `.env` 读取，不得打印、写进日志、测试或文件。测试里不发真实网络请求。
3. **不准 commit**。不准改 `skills/live2d-auto/*`、`tools/live2d-pipeline/*`。
4. 改已有测试只许改字面值（含重命名后的枚举值），不许改测试意图；需要改意图的写进报告「歧义」。
5. 不做任何额度/余额降级（D37）。
6. **台词、提示词一律原样使用** `characters/yuna/prompt.v1.md`、`characters/yuna/content.json` 和本说明 §2 的夏凛兜底台词；夏凛现有台词从代码里**原样搬运**。不许改写、润色或新增台词。UI 上的文字一律用中性占位（如 `LIVE`、`<输入框占位>`），集中放在一个 `uiText.ts` 常量文件，方便用户替换。

## 授权范围
- 新增：`characters/**`、`apps/server/src/characters/**`、`apps/client/src/live/**`（新 UI）、`apps/client/src/render/live2d/cubism/**` 的扩展、`apps/client/public/characters/**`、`tools/voice-pack/**`、`docs/voice-pack.md`、对应测试、`docs/tasks/s6b-report.md`。
- 可改：`packages/protocol/**`（枚举改通用槽位、hello 加 characterId）、`apps/server/src/**`（为接入角色包；**会话状态机、时间线、打断语义不改**）、`apps/client/src/**`（视图模型加「切换频道」意图；旧 `view/Stage.tsx` 可由新 UI 取代，但 `useStageViewModel` 的既有 4 个意图语义不变）、`prompts/rin.v1.md`（只许把动作名、意图名改成通用槽位，文字不动）、`e2e/**`。

---

## §1 角色包（`characters/<id>/`）
- 目录：`characters/rin/`、`characters/yuna/`。每个包含：`pack.json`（结构由你定义并写 zod schema）、`prompt.v1.md`、文字内容。夏凛的提示词从 `prompts/rin.v1.md` 移入 `characters/rin/prompt.v1.md`；Mock 剧本、意图关键词、`FALLBACK_LINES`、节点 label/guidance 从代码里**原样**搬进 `characters/rin/content.json`（结构与 `characters/yuna/content.json` 一致）。
- **通用槽位**（protocol 改动，旧名 → 新名，夏凛的语义不变）：
  - 意图：`ask_waiting→ask_core`、`ask_photo→ask_item`、`ask_radio→ask_job`、`comfort`、`greeting`、`other`。每个角色在 content.json 里给自己的关键词。
  - 动作：`sip_coffee→drink`、`glance_window→glance`、`check_phone→phone`、`show_polaroid→show_item`。提示词里各自解释含义。
  - 夏凛的 `prompts`/示例里的动作名同步改成新槽位名，其他文字不动。
- pack.json 至少包含：`id`、`displayName`、`renderer`（`{kind:"layered", …}` 或 `{kind:"live2d", model:"/models/yuna/yuna.model3.json"}`）、`voice`（`fishVoiceIdEnv`：夏凛 `FISH_VOICE_ID`，忧奈 `FISH_VOICE_ID_YUNA`；未设置时真实模式启动报错，提示要配哪个变量；`FISH_VOICE_ID_YUNA` 用户已在 .env 配好）、`prompt`、`content`、`media`（reveal 图、ending 视频）、`revealIntents`（probe→reveal 的触发意图；夏凛沿用现有 `ask_core|comfort`，忧奈同）、`stage`（背景、色调等渲染配置）。
- 纯函数 `parsePack(json) → Pack | Error`：zod 校验 + 交叉校验（所有节点 × 所有意图都有两句台词；fallback 五类齐全；动作只用通用槽位）。fast-check 属性测试：任意删掉一个必需字段都会被拒绝。
- 服务端启动时加载 `characters/*/pack.json`，任何一个不合法 → **启动报错退出**。
- 协议：客户端 `hello` 增加可选 `characterId`。缺省 → `rin`（兼容旧客户端和既有测试）；不存在的 id → 返回 `error{code:"unknown_character"}` 并关闭会话，**不回退夏凛**。
- 会话层按 pack 取：提示词、Mock 剧本、意图分类、剧情 label/guidance、revealIntents、媒体、TTS 音色、兜底台词。`classifyIntent` 改成接收 pack 的关键词表（仍是纯函数）。
- 忧奈的媒体占位：reveal 图 = 用预览页截一张忧奈的图，加一个像旧直播截图的框（CSS 或 ffmpeg 合成均可）；ending 视频 = ffmpeg 生成 6 秒的「直播间离线」画面（深色背景 + 中性占位词 `OFFLINE`）。都标注为占位素材，以后由用户替换。

## §2 情景化兜底（用户要求：卡住、没听清时角色用符合情景的话回应，不显示技术报错）
- 五类兜底，每个角色一套（台词见各自 content.json 的 `fallback`）：
  | 类别 | 触发 | 处理 |
  |---|---|---|
  | `stt_empty` | STT 返回空串（含 Fish 402/429 降级后的空串） | 现有路径，改用 pack 的台词 |
  | `stt_failed` | STT 抛其它错误（网络错误、超时、5xx） | 新增：不再走 turn_failed，改为说这句后正常 `turn_end{done}` |
  | `llm_timeout` | 现有 LLM 超时兜底 | 改用 pack 的台词 |
  | `turn_failed` | 其余未预期错误 | 服务端照常记录错误日志；客户端**不再显示**原始 `error code: message`，改为播放这句兜底；`retryable` 语义不变 |
  | `offline` | 客户端 WebSocket 断开/重连中 | **客户端本地**播放（服务端此时发不了消息），重连成功后不重复播放 |
- **兜底语音一律用预录音频**（出错的可能正是 TTS 或网络），文件按 §5 的清单放在 `apps/client/public/characters/<id>/voice/fallback/<类别>.mp3`；客户端直接播放本地文件，同时显示字幕。文件不存在时只显示字幕，不报错。
- 夏凛的兜底台词（新写的三条 + 原有两条原样保留）：
  - `stt_empty`：沿用现有「刚才没听清，你再说一遍好吗？」
  - `llm_timeout`：沿用现有「……抱歉，刚才走神了。你刚才说到哪了？」
  - `stt_failed`：「雨声太大了，信号断了一下……你刚才说什么？」
  - `turn_failed`：「店里的灯闪了一下。我们刚才说到哪了？」
  - `offline`：「……喂？好像断线了。」
- 原始错误信息只在开发面板（`?debug=1`）里显示。
- 测试：服务端集成测试覆盖 stt_empty / stt_failed / llm_timeout / turn_failed 四类各自发出对应 pack 的台词；客户端单测覆盖 offline 只播一次。故障注入（`FAULTS`）补一个 `stt_error`。

## §3 忧奈接入正式舞台
- 舞台按 `pack.renderer.kind` 选渲染器：`layered`（夏凛现有）或 `live2d`（忧奈，复用 S6a 的 Cubism 渲染外壳和 `yunaParams`）。
- 状态机 B 的输出（phase / emotion / mouth / look）接到 `yunaParams`；口型继续由音量驱动（D34）。
- 构图（用户 2026-10-27 确认）：模型立绘是**固定的半蹲姿势**（没有腿部/姿势参数）。直播间**全身展示**，让背景适应角色：背景是低机位的卧室地面，中间是一个空的大软垫，她蹲在软垫前。Claude 的合成样张：桌面人物高约画面 80%、中心在 56% 高处；手机人物高约 62%、中心在 66% 高处，水平居中。复用 s6a-fix2 的 `fitModel`，新增 `liveDesktop` / `liveMobile` 两组预设按这个比例来。
- **脚下加一个柔和的椭圆接触阴影**（CSS 径向渐变，放在 Live2D 画布下面、背景上面，宽约人物宽度的 70%，半透明深紫），避免人物悬空。手机上弹幕浮在左下角时不能盖住她的脸（弹幕区最高到画面 45% 处）。
- 动作 `drink/glance/phone/show_item` 对忧奈暂时只影响视线和情绪（没有对应 motion，YAGNI）；`show_item` 仍触发 reveal 媒体。

## §4 直播间 UI v1（`apps/client/src/live/`）
只读 `useStageViewModel()`；视图模型新增一个意图 `switchChannel(characterId)`：结束当前会话（进行中的一轮按打断处理，D34）并以新 `characterId` 重新 `hello`，**不保留**聊天记录。
- **桌面（宽 ≥ 900px，仿 Twitch）**：
  - 最左窄栏（约 56px）：两个频道头像（夏凛、忧奈），当前频道高亮，点击切换。
  - 中间：直播画面（角色 + 背景），左上角 `LIVE` 标记 + 主播名 + 固定观看人数占位；角色说的话以字幕显示在画面下方。
  - 右侧弹幕栏（约 340px）：弹幕列表（只有用户自己发的和语音转写的文字），底部是输入框 + 发送 + 麦克风（按住说话）。
- **手机（宽 < 900px，仿 TikTok / Instagram 直播）**：
  - 竖屏全屏画面，角色居中偏下。
  - 顶部左上角：头像 + 主播名 + `LIVE` 标记；右上角关闭/切换按钮。
  - 弹幕半透明浮在画面左下角（最多 6 条，新的在下，旧的向上淡出）。
  - 底部：胶囊输入框 + 麦克风按钮，安全区（`env(safe-area-inset-bottom)`）留白。
  - **上下滑动切换主播**（阈值约 80px 或速度足够），切换时整屏滑动过渡。
- 风格：参考《主播女孩重度依赖》——粉紫配色、像素字体点缀、老式系统窗口边框的质感。**只借风格，不用原作素材**。颜色集中成 CSS 变量。
- 纯函数：`danmakuReducer`（追加、最多条数、淡出顺序）、`pickLayout(width)`、`swipeDecision(dy, vy)`，都要单测。
- 旧 `view/Stage.tsx` 保留可用（`?legacy=1`），e2e 的旧用例改为走新 UI 时只许改选择器字面值。

## §5 语音包清单（用户自己生成录音）
- **不调用 Fish 录音**，不跑 `voices:record`。写一个脚本 `pnpm voices:list`，从两个角色包导出所有需要预录的台词：Mock 剧本每句、nudge、五类兜底。
- 输出：
  - `characters/<id>/voice-pack.json`：每条 `{ key, file, text, emotion, node?, intent?, category }`，`file` 是客户端/服务端期望的相对路径。key 沿用现有 `voiceKey.ts` 规则。
  - `docs/voice-pack.md`：给用户看的清单，按角色、类别分表（文件名 | 台词 | 情绪 | 场景），开头写清格式要求（mp3、单声道、44.1kHz、开头结尾留 0.1 秒静音）和放置目录。
- Mock 模式找不到某条录音时：照旧按现有逻辑处理（静音 beat + 字幕），不报错。

## §5.5 忧奈背景 + 真实生图适配器
- **背景**：忧奈的场景设定在她家卧室（用户 2026-10-27）。背景已由 Claude 生成好：`apps/client/public/characters/yuna/bg-desktop.jpg`（1536×1024）和 `bg-mobile.jpg`（1024×1536）。写进 pack 的 `stage`，桌面和手机各用各的；角色全身蹲在画面中间的软垫前（见 §3 构图）。不许重新生成或修改这两张图。
- **真实生图**（题目 §5「根据当前对话动态生成的场景图片」，D7/D27 早已定了流程，但之前只有 `presetMedia` 模拟）：
  - 新增 `apps/server/src/adapters/media/imageGen.ts`，实现现有 `MediaPort`。OpenAI 兼容接口 `POST {IMAGE_BASE_URL}/v1/images/generations`，`model` 默认 `gpt-image-2.5-sunburst`（`IMAGE_MODEL` 可覆盖），取返回的 `b64_json`，存到服务端可访问的静态目录后返回 URL。Key 只从 `IMAGE_API_KEY` 读取。实测单张 23–31 秒。
  - 生图提示词 = 角色包 content.json 里的 `imagePrompt` 模板（忧奈已写好；夏凛用下面这句，原样放进 `characters/rin/content.json`：`Instant film polaroid photo, no people, no readable text, no logos. A rainy night street outside a small cafe that is about to close, wet asphalt reflecting warm shop lights, soft grain, slightly faded colors, intimate and quiet. Details inspired by the recent conversation: {{conversation}}`），`{{conversation}}` 替换为最近 3 轮对话的摘要（纯函数 `buildImagePrompt(pack, history)`，单测）。
  - 流程沿用 D27：剧情进 reveal 时发起后台任务 → 客户端先显示「生成中」（夏凛 = 空白相纸显影；忧奈 = 截图加载中的样式）→ 就绪后显示 → **失败或超过 60 秒** 显示 pack 里的预置图。打断不取消生图（D27）。
  - `IMAGE_API_KEY` 未配置时用 `presetMedia`（这是配置选择，不是余额降级）；测试里注入假 fetch，不发真实请求。
- 测试：`buildImagePrompt` 单测；`imageGen` 集成测试（假 fetch：成功、HTTP 错误、超时 → 都按契约返回）。

## §6 测试要求（测试奖杯）
- 单测：`parsePack`（含 fast-check）、`classifyIntent`（两套关键词）、`danmakuReducer`、`pickLayout`、`swipeDecision`、offline 兜底只播一次。
- 集成：两个角色包都能在 Mock 模式下跑完 arrive → ending；未知 characterId 返回 `unknown_character`；§2 四类服务端兜底。
- e2e：桌面 1440×900 与手机 390×844 各跑：发一条弹幕收到回复、切换频道（手机用滑动）、截图存 `e2e/out/live-*.png`。
- 全部通过：`pnpm test`、`pnpm typecheck`、`pnpm smoke`、`pnpm e2e`。真实网络只出现在 `pnpm smoke:real`。

## §7 报告（`docs/tasks/s6b-report.md`）
改了哪些文件；protocol 改名清单；pack schema；测试数；截图路径；歧义与处理。

## 引用
Q10、D21、D28、D32、D34、D37、D38、D39、D40。
