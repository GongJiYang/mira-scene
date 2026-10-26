# G2 预研：P1 / P2 / P3 探针（真实服务实测）

你是执行工程师。不要 commit，也不要修改 `docs/architecture/`。
只读背景：`decisions.md` 中的 D16、D17、D29、D30、D31，以及 `quality-scenarios.md` 中的 Q3。
**另一个 Agent 正在 `tools/live2d-pipeline/` 下工作，还有一个在改 `apps/server` 的故障注入。这两处你都不要碰。**

## 铁律
1. 说明和实际结果冲突时，停下来报告，不要擅自修改验收标准。
2. **Key 只能从仓库根目录的 `.env` 读取**（`FISH_API_KEY`、`DEEPSEEK_API_KEY`），不得打印、写入日志或写入任何文件，报错信息里也要把 Key 脱敏。缺少 Key 时退出码为 2。
3. 新代码一律放在 `tools/probes/`，不得修改 `apps/` 和 `packages/`。可以 import `packages/protocol` 里的 `parseLlmBeatLenient` 和相关 schema。
4. **控制花费**：P1 每种格式最多 20 次调用，P2 最多 6 次，P3 最多 12 次。不允许为了刷数据而重复调用。

## 允许的依赖
在 `tools/probes/package.json` 中添加（同时加入 workspace）：`ai`、`@ai-sdk/openai-compatible`、`dotenv`、`tsx`。

## P1：LLM 输出格式对比（D16、D31）
- 固定 20 条输入，写在 `tools/probes/p1/inputs.json`，覆盖以下类型：寒暄、问她在等谁、问照片、问电台、表达关心、跑题、注入攻击、英文输入、超长输入、只有一个字的输入。
- 人设暂时使用 Mock 剧本里的「凛」（`apps/server/src/adapters/mock/mockLlm.ts` 的设定）。人设写在一个独立文件里，之后会换角色。
- 三种格式段要能整块替换，放在 `tools/probes/p1/formats/`：
  - **a** 逐行 JSON，每行一个 `{say, emotion, suggest?, advance?}`；
  - **b** AI SDK 的 `streamObject`，array 模式，schema 用 LlmBeat；
  - **e** 行内标签，形如 `[emotion]台词<act:xxx><advance:xxx>`，按句号切分。
- 调用 DeepSeek（OpenAI 兼容接口，`DEEPSEEK_BASE_URL`，模型 `DEEPSEEK_MODEL`），**关闭思考**（请求体加上 `thinking: {type: "disabled"}`），使用流式输出。
- 每条输入的每种格式记录：首个合法 beat 的到达时间（ms）、总耗时、解析成功率（不需要宽松修正就能解析的 beat 占比）、枚举值合法率、第一句字数是否 ≤20，以及前缀缓存命中情况（如果响应的 usage 里带有缓存字段）。
- 取消测试：每种格式各做 3 次，收到第一个 beat 后立即 abort，确认流在 500ms 内结束。
- 产出 `tools/probes/out/p1-<时间戳>.json`，以及一份 markdown 矩阵，按 D16 的权重算加权总分：首句延迟 40%、合规率 30%、复杂度 15%、取消友好度 15%。复杂度是主观分，要写明理由。附上每种格式的 2 条原始输出样例。

## P2：Fish STT 对浏览器录音格式的支持
- 用 macOS 的 `say -v Ting-Ting` 生成一段固定中文语音，再用 ffmpeg 转成 `webm(opus)`、`mp4(aac)`、`wav` 三种格式。
- 分别调用 Fish 的 speech-to-text 接口（模型 `transcribe-1-pro`，参照 https://docs.fish.audio 的 API 文档），记录：是否成功、识别出的文本、字错率、耗时。

## P3：Fish TTS 情绪听感与首包延迟
- 同一句台词，用 `apps/server/src/director/vocab.ts` 中 6 种情绪对应的 Fish 标签合成；模型用 `s2.1-pro-free`，有余力的话再加 `drama-3`（总调用数 ≤12）。音色用 `FISH_VOICE_ID`，为空时用 Fish 的默认音色，并在报告里注明。
- 记录首字节时间和总耗时，音频存到 `tools/probes/out/p3/<模型>/<情绪>.mp3`。
- 生成一个**打乱顺序**的盲听页面 `tools/probes/out/p3/blind.html`（纯静态）：可以逐条播放，并选择自己听到的情绪；提交后显示正确率。

## 运行入口
`pnpm probe:p1`、`pnpm probe:p2`、`pnpm probe:p3`、`pnpm probe:all`，每个都支持 `--mock`（不联网，只验证流程）。

## 完成标准
- 先用 `--mock` 跑通全部三个探针，再用真实服务各跑一次。
- `pnpm test` 和 `pnpm typecheck` 不受影响。
- 写 `docs/tasks/g2-probes-report.md`，内容包括：P1 的矩阵和推荐格式（附理由）、P1 的延迟分布（P50/P90）、P2 的格式支持结论、P3 的首包延迟、盲听页面的位置、调用总次数，以及接口理解上不确定的地方（附文档 URL）。**不要替用户下「听感」结论**，这一项由用户盲听判断。
