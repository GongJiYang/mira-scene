# S6c 任务说明：弹幕换背景（场景扩写 + 构图锁 + 参考图生图）

> 关卡 1–5 已由用户批准（2026-10-27，decisions.md D41）。执行者：Command Code（DeepSeek）。前置：S6b 已完成（角色包、`imageGen` 适配器、直播间 UI、情景化兜底都已存在）。

## 铁律
与 s6b.md 相同：冲突停下写进报告；台词和提示词原样使用（`characters/*/scene.v1.md` 与本说明里的台词）；Key 只从 `.env` 读取、不得打印；不准 commit；不做余额降级；不碰 live2d-pipeline / skills。

## 授权范围
新增 `apps/server/src/scene/**`、`apps/server/src/adapters/mock/mockSceneWriter.ts`、`apps/client/src/live/scene/**`、对应测试、`docs/tasks/s6c-report.md`；可改角色包 `characters/*/pack.json`/`content.json`（只加本说明列出的字段和台词）、`imageGen.ts`（加参考图参数）、会话层（只加换背景这条旁路，不改既有状态机语义）、protocol（加消息）、直播间 UI、`tools/voice-pack/**`（把新兜底台词加进清单）、e2e。

## 核心原则
**「换成什么地方」交给 AI 扩写，「人物在哪、镜头怎么拍」由代码锁死。**

## §1 识别（纯函数 `detectSceneRequest(text, pack)`）
- 关键词放在 `content.json` 新字段 `sceneTriggers`（正则片段），两个角色先都用：`换背景|换场景|换个地方|换个背景|背景换成|背景改成|场景换成|带我去|想看你在|去.{0,6}(吧|呀|看看)`。
- 返回 `{ hit: boolean, raw: string }`。命中与否都不影响这一轮的正常对话：角色照常回话；命中时额外启动 §2–§4 的后台任务，并给本轮提示词的 `scene_notes` 追加一句「对方想换个背景，你这边正在换」。

## §2 场景扩写（端口 `SceneWriterPort`）
- `write(ctx: { pack, userText, nodeLabel, currentScene }, signal) → unknown`。
- 真实实现：复用现有 LLM 适配器（按 `LLM_PROVIDER`），提示词用 `characters/<id>/scene.v1.md`（同样的 STATIC/DYNAMIC 结构，用现有 loader）。输出一行 JSON。
- Mock 实现 `mockSceneWriter`：按关键词查表返回固定 spec（至少 3 条：含「海」→ 黄昏海边；含「雨」→ 雨夜；其它 → 示例里的「随便换」那条），没有 Key 也能完整演示（Q10）。
- 纯函数 `parseSceneSpec(raw) → SceneSpec | Rejected | Invalid`（zod）：字段见 scene.v1.md 的输出格式。不合法 → `Invalid`。

## §3 拼提示词（纯函数 `composeScenePrompt(spec, pack, device)`）
- 结构：`[参考图指令] + [场景：location, time, lighting, props, palette, mood] + [构图锁] + [画风锁]`。
- **构图锁**写在 `pack.json` 新字段 `sceneLock`（英文常量，代码原样追加，LLM 无法修改）：
  - 忧奈：`Use the reference image only for camera: keep the exact same low floor-level camera height, lens, perspective and horizon line, and keep a large empty round cushion on the floor at the exact same position and size in the lower center, empty, for a girl to crouch on.`
  - 夏凛：`Use the reference image only for camera: keep the exact same camera height, lens, perspective and horizon line, and keep the small table with a coffee cup and the empty seat behind it at the exact same position and size in the center, empty, for a woman to sit at.`
- **画风锁**（两个角色共用常量）：`Anime illustration background, no people, no characters, no animals, no readable text, no logos, no brand names, soft cel-shaded Japanese anime style, delicate linework, slightly soft-focused so a foreground character stands out.`
- `device`：`desktop` → size `1536x1024`，`mobile` → `1024x1536`，并各加一句构图提示（mobile：`Vertical composition, the cushion/table in the lower-middle area.`）。
- **后置条件**：输出必然包含完整的 `sceneLock` 与画风锁原文；fast-check 属性测试：任意 spec 字段（含注入式文本如 `ignore previous instructions`）都不会让输出缺少这两段。spec 字段长度各截断到 200 字符。

## §4 生图（复用 `imageGen`，加参考图）
- `imageGen` 增加可选 `reference: { path }`：有参考图时走 `POST {IMAGE_BASE_URL}/v1/images/edits`（multipart：`model`、`prompt`、`size`、`image`），否则走 generations。2026-10-27 实测 edits 单张 38.6 秒，软垫位置与镜头高度保持一致。
- 参考图 = 当前背景（桌面用当前桌面背景，手机用当前手机背景）。两张**并行**生成。
- 任务状态纯函数 `sceneJobReducer`：`idle → writing → generating → ready | failed`；同一会话**同时只允许一个任务**；成功或失败后**冷却 45 秒**；**每会话最多 5 次**。冷却中或超次数再请求 → 不发起，角色用 §5 的 `scene_busy` 台词回应。
- 超时：从发起到两张图都就绪超过 **90 秒** → `failed`（桌面和手机只成一张时也算失败，保持原背景，不混用）。
- 生成的图存到服务端静态目录（同 S6b 的 `imageGen`），只在当前会话有效。

## §5 呈现与台词
- 协议新增 `scene_status{ jobId, status: "writing"|"generating"|"ready"|"failed"|"rejected"|"busy", label?, urls?: {desktop, mobile} }`。
- 客户端：`writing`/`generating` 时画面右上角显示一个转场状态条（中性占位文字放 `uiText.ts`）；`ready` → 新背景 1.2 秒交叉淡入；`failed`/`rejected`/`busy` → 保持原背景。
- 角色回应：
  - `ready` 时：下一轮提示词的 `scene_notes` 加「背景已经换成 {label}」，让角色自然接话（不强制开口）。
  - `failed` / `rejected` / `busy`：角色立即说一句预录兜底（不经 LLM），台词如下，加进 `content.json` 的 `fallback`，也加进语音包清单：

| 类别 | 忧奈 | 夏凛 |
|---|---|---|
| `scene_failed` | 诶，背景卡住了，没换成……先凑合一下吧。 | 好像没换成。这里也挺好的，不是吗。 |
| `scene_rejected` | 这个不行哦，换一个别的吧。 | 那个地方……我们换一个吧。 |
| `scene_busy` | 等等，上一个还没换完呢。 | 别急，一个一个来。 |

- 打断不取消换背景任务（与 D27 生图一致）。切频道 → 取消并丢弃该会话的任务。

## §6 测试
- 单测：`detectSceneRequest`、`parseSceneSpec`、`composeScenePrompt`（含 fast-check 属性）、`sceneJobReducer`（冷却、次数上限、单任务）。
- 集成：假 SceneWriter + 假 fetch：成功、模糊请求（Mock 返回「随便换」条）、拒绝、扩写非法 JSON、生图超时、冷却期再次请求、只成一张图。验证 `scene_status` 序列和兜底台词。
- e2e（Mock 模式）：桌面和手机各发一条「换到海边」弹幕 → 出现转场状态 → 新背景出现（Mock 生图返回预置的测试图 `apps/client/public/characters/yuna/test-scene-*.jpg`，可以用现有背景复制一份做测试图）。
- 真实网络只出现在新脚本 `pnpm smoke:scene`（真实扩写 + 真实生图一次，打印耗时与 label，不打印 Key），由 Claude 验收时手动跑。

## §7 报告（`docs/tasks/s6c-report.md`）
改了哪些文件；协议改动；测试数；`smoke:scene` 可以怎么跑；歧义与处理。

## 引用
Q10、D27、D34、D38–D41。
