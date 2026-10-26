# S3 修复轮（关卡 8/9 验收发现的问题）

背景：`docs/tasks/s3.md`、`docs/tasks/s3-report.md`。铁律、授权范围与 s3.md 相同：不要 commit；Key 只从 .env 读取，不能打印；测试里不允许真实网络请求；现有 327 个测试的意图保持不变；不要碰 `tools/`。

## 1. `parseBeatLines`：坏行不能把 JSON 符号送进 TTS（中）
- 现状：解析不了的行会整行原样当作台词，`{…}{…}` 粘连或截断的 JSON 会被念出来。
- 修法：一行解析失败时，按以下顺序处理：
  ① 如果以 `{` 开头，按 `}{`（允许中间有空白）拆开后逐段解析；
  ② 用正则提取 `"say"\s*:\s*"((?:[^"\\]|\\.)*)"`（以及 emotion，如果有的话），得到一个 beat；
  ③ 如果这一行**看起来像 JSON**（以 `{` 或 `[` 开头，或者含有 `":`），以上都失败就**丢弃**，只写 warning；
  ④ 只有完全不像 JSON 的纯文本，才降级成台词。
- 测试：以上四条各写用例；另外加 fast-check 属性测试（≥500 次）：随机生成 JSON 行、粘连行、截断行、纯文本行，**输出的任何 `say` 都不能包含 `{"` 或 `":`**。

## 2. `advanceRule`：「进入 reveal 两轮后」才允许 ending（中）
- 现状：用的是全局轮次 ≥4，reveal 的下一轮就会允许结束。
- 修法：会话的 scene 里新增 `revealTurn`（进入 reveal 时的轮次，可选字段；在 `packages/protocol` 的 SceneState 里**只新增可选字段**）。`advanceRule` 改为 `turnCount - revealTurn >= 2` 时才允许 ending。
- 测试：在第 8 轮进入 reveal 时，第 9 轮不允许、第 10 轮允许；没有 revealTurn 时不允许 ending。

## 3. `paceGuard`：第一句不重试（中，影响 Q3 首句延迟）
- 修法：`synthesize` 的 opts 里增加可选字段 `beatSeq`（由会话层传入）。`beatSeq === 0` 时只检查、写 warning，**不重试**；第二句及以后维持原逻辑。
- 测试：seq0 超出范围时只请求 1 次；seq1 超出范围时请求 2 次。

## 4. 小问题
- 意图识别 `classifyIntent` 从 `adapters/mock/mockLlm.ts` 挪到 `apps/server/src/intent.ts`，mock 和 prompts 都从这里 import（核心模块不能依赖 Mock 适配器）。
- `session.ts` 的 `stt_done` 日志里不再记录原文，改为 `chars: 字数`。
- `fishTts` 余额耗尽的标记在**成功请求一次之后**自动清除；另外每 5 分钟允许探测一次真实请求。在 `docs/tasks/s3-fix-report.md` 里说明这一行为。

## 完成标准
`pnpm test`、`pnpm typecheck`、`pnpm smoke` 全部通过；写 `docs/tasks/s3-fix-report.md`，列出改动文件、新增测试和测试输出摘要。
