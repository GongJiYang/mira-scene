# 后续核心开发骨架（S3–S6）

> 2026-10-26。已完成部分：S1–S2、G1-a/b/c（249 个测试，提交 `78c29fe`）。
> 每个阶段都写成 `docs/tasks/<阶段>.md`，派发给 oh-my-pi + DeepSeek Flash 执行；验收以 Q 编号为准，每阶段验收后提交一次。

## 依赖关系

```
G2 预研（P1 LLM 格式 · P2 STT 格式 · P3 情绪听感）──▶ S3 真实语音 ──┐
新角色设定 + 人工分层 ──▶ psd2live 导出 ──▶ S4 视觉 ───────────────┼─▶ S5 降级与移动端 ─▶ S6 交付
用户的 UI 设计稿 ─────────────────────────▶ S4 / S5 接入视图层 ─────┘
扩展（核心验收后）：E1 免按住实时语音 · E2 观测与回放
```

## 新增模块总览（在现有目录上增加）

```
apps/server/src/
  adapters/fish/        stt.ts  tts.ts（按句合成，可选 tts/live 流式）
  adapters/deepseek/    llm.ts（OpenAI 兼容，关闭思考，格式由 P1 选定）
  adapters/faults.ts    故障注入装饰器（?fail=…）
  quality/paceCheck.ts  语速体检（参考 voice-workbench）
  prompts/loader.ts     读取 prompts/<角色>.v1.md，日志记录版本号
  media/                生图任务（拍立得，gpt-image，后续接入）+ 预置照片兜底
prompts/<角色>.v1.md    静态前缀（人设/边界/格式/示例）+ 动态后缀模板
apps/client/src/
  render/live2d/        Live2D 运行时接入：状态机 B → Live2D 参数
  render/fallback/      D24 PixiJS 分层兜底
  render/stage/         背景、前景、雨（代码叠加）、镜头、拍立得显影
  docs/                 开发文档窗口（react-markdown）
  observe/              观测：每轮 4 个时间点、事件流、回放（E2）
  voice/vad.ts          免按住模式（E1）
assets/<新角色>/        PSD → psd2live 输出（moc3/model3.json/…）、场景、预置照片
e2e/                    Playwright：手机视口、打断、故障注入、录屏
deploy/                 一条命令上线（参照 voice-workbench 的 deploy.sh + Caddy）
```

## 各阶段任务

### G2 预研（需要 `.env` 中的 FISH_API_KEY、DEEPSEEK_API_KEY）
| 探针 | 输出 | 验收 |
|---|---|---|
| P1 LLM 格式 | a 逐行 JSON / b AI SDK streamObject / e 行内标签：20 条固定输入下的合规率与首句耗时 | 用决策矩阵选定一种（D16） |
| P2 STT 格式 | Chrome webm、Safari mp4 能否被 Fish 识别 | 不能识别就改用浏览器端录 WAV |
| P3 情绪听感 | 用不同情绪标签合成同一句话，记录首包耗时 | 用户盲听能分辨出 3 种 |

### S3 真实语音（Q3、Q5、Q6、Q14）
1. Fish STT/TTS 适配器、DeepSeek 适配器（按 P1 结论），Mock 保留为默认。
2. 提示词 v1（Claude 起草，用户审阅），用前缀缓存。
3. 每轮测量 4 个时间点，**只优化瓶颈**（D17）；做「嗯……」反应音（可被打断）。
4. 语速体检 + TTS 失败重试 1 次 → 降为无声 beat。
5. 主动行动（12s nudge）接入服务端：生成一句主动台词。

### S4 视觉（Q1、Q8、Q9、§4、§5）
1. 选定 Live2D 网页运行时（Cubism Web SDK 或 p2lrt）。
2. 状态机 B → Live2D 参数：眨眼、口型、头部角度、呼吸、表情 exp3、动作 motion3。
3. 舞台：背景切换（雨停、打烊）、代码叠加的雨、推镜、前景桌面。
4. 拍立得显影：状态机 C 接入画面；生图端口（gpt-image）+ 预置照片兜底。
5. 兜底：Live2D 加载失败时切换到 D24 分层立绘。

### S5 降级与移动端（Q4–Q7、Q9–Q12）
1. 故障注入装饰器，覆盖 llm_timeout / tts / video / ws_drop。
2. 回放模式（Mock 语音方案 A 或 B 待定），额度用完时自动切换。
3. iOS 音频解锁、竖屏适配、没有横向滚动；Playwright 手机视口测试。

### S6 交付
README 八项（取自本目录的各文档）· AI_USAGE.md（取自 `docs/ai-usage-log.md`）· 开发文档窗口 · 3–5 分钟录屏（Playwright 辅助录制）· 部署上线。

### 扩展（核心全部验收后）
- E1 免按住实时语音：vad-web + 回声消除 + 先降音量再确认打断 + 附和词过滤（C1）。
- E2 观测与回放：事件日志回放、延迟和错误面板，合并进开发文档窗口。

## 参考的开源项目与可复用资产

| 用在哪里 | 项目 | 怎么用 |
|---|---|---|
| Live2D 自动绑定 | **psd2live**（GPL-3.0 工具；p2lrt 运行时为 MIT） | PSD → moc3/model3.json，已验证可用 |
| 图层分离 | **See-through**（开源）/ Qwen-Image-Layered / Seedream 5.0 Pro | 立绘 → PSD 草稿，再由人工修补 |
| Live2D 网页渲染 | Cubism Web SDK + pixi-live2d-display，或 p2lrt WebGL | S4 选定其一 |
| 兜底渲染 | PixiJS v8 | D24 分层 + 网格 |
| LLM 流式结构化输出 | Vercel AI SDK `streamObject`（P1 候选 b） | 逐个元素流式输出 + zod 校验 |
| 开发文档窗口 | react-markdown + remark-gfm | 渲染 docs/*.md |
| 免按住说话 | @ricky0123/vad-web（Silero VAD） | E1 |
| 录音兜底 | extendable-media-recorder + WAV 编码器 | 视 P2 结果决定 |
| 端到端测试与录屏 | Playwright | 手机视口、打断、故障注入 |
| 属性测试 | fast-check（已在用） | 导演层模糊测试 |
| 基础设施 | ws、zustand、zod、vitest（已在用） | — |
| **只借鉴思路** | LiveKit Agents（假打断恢复、最短打断时长）、Pipecat / TEN（轮次检测）、OpenAI Realtime 的 VAD 参数 | E1 调参参考 |
| **用户自己的项目** | voice-workbench：`emotion_vocab`（D29）、`pace_check` 语速体检、不用 `[pause]` 标签的经验、Fish `s2.1-pro-free`、音色筛选、`deploy.sh` + Caddy | S3、S6 |
