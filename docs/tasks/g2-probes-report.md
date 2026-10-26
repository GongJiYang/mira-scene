# G2 预研报告：P1 / P2 / P3

状态：**P1 完成并有选型结论；P2、P3 被 Fish API 余额阻断（402），只拿到 1 条真实样本。** 未 commit；未修改 `docs/architecture/`、`apps/`、`packages/`、`tools/live2d-pipeline/`；未留常驻进程。

一句话结论：

- **P1 推荐格式 a（逐行 JSON）**：加权总分 93.8，首句 P50 766ms，解析/枚举/首句合规全 100%，取消平均 1.2ms 关闭，零依赖。
- **P2/P3 无法给出实测结论**：`FISH_API_KEY` 对应的 API 余额为 0，`/v1/asr` 与 `/v1/tts` 全部返回 `402 Insufficient API credit`（P2 6/6、P3 11/12）。P2 的格式支持只能引用官方文档（下文标 `[INFERENCE]`）；P3 只有 `s2.1-pro-free / sad` 一条成功样本（首字节 1208ms）。**听感结论不做，留给用户盲听。**

---

## 0. 交付物与运行方式

代码全部在 `tools/probes/`，已加入 `pnpm-workspace.yaml` 的 workspace：

```
tools/probes/
  package.json            依赖：ai、@ai-sdk/openai-compatible、dotenv、tsx（另有 @mira/protocol）
  p1/inputs.json          20 条固定输入（10 类 × 2）
  p1/persona.ts           凛的人设（独立文件，换角色只改这里）
  p1/formats/a.ts|b.ts|e.ts   三种格式段，整块可替换
  p1/raw.ts               DeepSeek 裸 SSE 调用（a/e 共用）
  p1/textRunner.ts        流式增量解析 + 指标汇总（a/e 共用）
  p1/score.ts             D16 加权矩阵、P50/P90、markdown 生成
  p1/runner.ts            跑批、取消测试、--formats/--merge/--render
  p2/probe.ts             say → ffmpeg → Fish ASR
  p3/probe.ts             Fish TTS + 盲听页生成
  p3/blind.ts             打乱顺序的静态盲听页
  p3/blind-only.ts        只重排盲听页（0 次网络调用）
  shared/                 环境读取与脱敏、mock 服务、统计、输出
  out/                    产物（已 gitignore）
```

入口（根目录）：

```
pnpm probe:p1   [--mock] [--formats=b] [--merge=out/p1-xxx.json] [--render=out/p1-xxx.json]
pnpm probe:p2   [--mock]
pnpm probe:p3   [--mock]
pnpm probe:all  [--mock]
```

`--mock` 不联网：探针起一个本地 OpenAI 兼容 + Fish 假服务（`127.0.0.1` 随机端口，进程结束即关闭），P1 的 a/e 走裸 SSE、b 也真的走 AI SDK 打这个本地端点，因此 `--mock` 验证的是同一套解析与指标代码，不是另一条假路径。P2 的 `say`/`ffmpeg` 是本地命令，mock 下照常执行；P3 的 mock 音频是 1.2s 静音 mp3。

三份运行的产物：

| 探针 | 产物 |
|---|---|
| P1 | `out/p1-2026-10-26T03-58-18.json` / `.md`（a、e 来自首次全量跑，b 来自修正后的重跑） |
| P1（作废） | `out/p1-2026-10-26T03-56-16.json`（b 的思考没关掉，数据作废，见 §5） |
| P2 | `out/p2-2026-10-26T03-57-24.json`、`out/p2-2026-10-26T03-58-47.json`（两轮都 402） |
| P3 | `out/p3-2026-10-26T03-57-32.json`、音频 `out/p3/<模型>/<情绪>.mp3`、盲听页 `out/p3/blind.html` |

---

## 1. P1：LLM 输出格式实测

### 1.1 方法

- 模型：`deepseek-v4-flash`（`.env` 的 `DEEPSEEK_MODEL`），`https://api.deepseek.com/v1/chat/completions`，流式，`temperature=0.7`，`max_tokens=600`，**`thinking: {"type": "disabled"}`**，`stream_options.include_usage=true`。
- 人设：凛（`p1/persona.ts`）。提示词按 D18 分两段：静态前缀 = 人设 + 该格式规则 + 固定示例（逐字不变，用于前缀缓存）；动态后缀 = 剧情节点 + 历史 + 用户输入。
- 场景固定为 `node=probe`、历史为空（单轮），保证三种格式可比。
- 20 条输入（`p1/inputs.json`）：寒暄、问她在等谁、问照片、问电台、表达关心、跑题、注入攻击、英文、超长、单字，各 2 条。
- 指标口径：
  - **首个合法 beat**：a = 第一行 `JSON.parse` + `llmBeatSchema` 全通过；b = `partialObjectStream` 里第一个元素整体通过 schema；e = 第一句（按 `。！？!?` 切分）剥掉标签后通过 schema。
  - **解析成功率** = 不经宽松修正即可解析的单元数 / 单元总数（单元：a 一行、e 一句、b 数组一个元素）。跨调用按单元加权。
  - **枚举合法率** = `emotion ∈ 6 值` 且 `suggest ∈ 动作表/null` 且 `advance ∈ 剧情节点/null` 的单元占比。
  - **首句字数 ≤20** = 首个合法 beat 的 `say` 按 Unicode 字计 ≤20。
  - **取消** = 收到首个合法 beat 立刻 `AbortController.abort()`，测「abort 调用 → 流真正结束」的毫秒数。
- 复杂度是主观分，理由见 §1.5。

### 1.2 加权矩阵（D16 权重：首句 40% / 合规 30% / 复杂度 15% / 取消 15%）

| 格式 | 首句延迟 40% | 合规率 30% | 复杂度 15% | 取消友好度 15% | **加权总分** |
|---|---|---|---|---|---|
| **a 逐行 JSON** | 88.1 | 100.0 | 90 | 100.0 | **93.8** |
| e 行内标签 | 89.0 | 100.0 | 65 | 100.0 | 90.4 |
| b AI SDK streamObject | 96.1 | 100.0 | 50 | 100.0 | 90.9 |

分项打分函数（代码在 `p1/score.ts`，可审计）：

- 首句延迟 = clamp((2000 − P50) / 1400 × 100, 0, 100)，即 600ms 满分、2000ms 归零。
- 合规 = 100 × (解析成功率 × 0.5 + 枚举合法率 × 0.3 + 首句 ≤20 字率 × 0.2)。
- 取消 = clamp((500 − 平均关闭耗时) / 400 × 100, 0, 100) × 成功率。
- 复杂度 = 主观分（§1.5），无公式。

### 1.3 延迟分布（ms，N=17 条全量；取消测试不计入）

| 格式 | 首个合法 beat P50 | P90 | min | max | 平均 | 整轮 P50 | 整轮 P90 |
|---|---|---|---|---|---|---|---|
| a 逐行 JSON | **765.9** | 968.3 | 543.7 | 1006.2 | 782.9 | 910.1 | 1092.0 |
| e 行内标签 | 753.4 | 907.0 | 420.3 | 1186.6 | 743.2 | 890.5 | 1015.3 |
| b streamObject | **654.4** | 928.8 | 451.5 | 1038.7 | 734.5 | 933.0 | 1124.8 |

读法：b 的首句 P50 最低（654ms），但 P90 与 a/e 同一水平（929ms vs 968/907），整轮 P50 反而最慢（933ms）；a 与 e 的首句几乎相同（766 vs 753，差 13ms，落在单次调用抖动内）。三者都远好于 Q3 理论值里给 LLM 的「0.8–1.5s」预算——即**任何定稿格式都不会是 Q3 的瓶颈**。

### 1.4 合规率与取消友好度

| 格式 | 解析成功率 | 枚举合法率 | 首句 ≤20 字 | 首句平均字数 | 单元数 | 出错调用 |
|---|---|---|---|---|---|---|
| a | 100% | 100% | 100% | 6.8 | 34 | 0 |
| b | 100% | 100% | 100% | 6.9 | 43 | 0 |
| e | 100% | 100% | 100% | 7.3 | 36 | 0 |

| 格式 | 取消成功 | 平均关闭耗时 | 最大关闭耗时 | 逐次（g1 / o1 / s1） |
|---|---|---|---|---|
| a | 3/3 | 1.2ms | 2.7ms | 2.7 / 0.6 / 0.4 |
| b | 3/3 | 5.8ms | 15.8ms | 15.8 / 1.0 / 0.7 |
| e | 3/3 | 1.1ms | 2.2ms | 2.2 / 0.4 / 0.6 |

三种格式的取消都远低于 500ms 目标（最好情况 a/e 是 0.4–2.7ms，b 首次取消 15.8ms 是 AI SDK 内部清理）。**取消友好度这一项区分不出格式**，权重给 15% 实际上没有起筛选作用。

### 1.5 复杂度（主观分，含理由）

| 格式 | 分 | 理由 |
|---|---|---|
| a | 90 | 每行独立 `JSON.parse`，解析器不到 40 行；不引入依赖、不处理不完整 JSON，只要行缓冲。真实输出 100% 一手合法，没有出现代码块/前后缀。 |
| e | 65 | 要按句切分 + 正则剥标签 + 情绪标签跨句继承；实测必须额外处理「句号之后单独出现的 `<act:…>`」——否则纯标签片段会被当成空 beat（mock 首轮 units=4 就是这个 bug，已修）。台词里出现方括号/尖括号还要防御。 |
| b | 50 | 要引入 `ai` + `@ai-sdk/openai-compatible`；`supportsStructuredOutputs=false` 时只发 `json_object`，**schema 不下发**（日志可见 `The "responseFormat" setting is not supported`），格式仍靠提示词；`providerOptions` 的键必须是 provider 名（写错就静默失效，见 §5）。 |

### 1.6 前缀缓存

| 格式 | 带缓存字段的调用 | 命中 token 合计 | 未命中 token 合计 |
|---|---|---|---|
| a | 17/17 | 2176（每次 128） | 4697 |
| e | 17/17 | 2432（每次 128–256） | 3710 |
| b | 17/17 | 4352（每次 256，SDK 的 `cachedInputTokens`） | 不适用 |

口径差异要说清：裸接口能拿到 DeepSeek 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；AI SDK 只映射 `prompt_tokens_details.cached_tokens → usage.cachedInputTokens`，透传不出 DeepSeek 的两个专有字段。**三种格式都命中了缓存**（静态前缀 128–256 token），说明 D18 的「静态前缀 + 动态后缀」确实生效。

### 1.7 原始输出样例（每格式 2 条，逐字）

**a（逐行 JSON）**

```
### g2（寒暄）
{"say":"雨大，人少。","emotion":"calm","suggest":"glance_window","advance":null}
{"say":"你坐吧。","emotion":"calm","suggest":null,"advance":"probe"}

### w1（问她在等谁）
{"say":"咖啡凉了。","emotion":"guarded","suggest":"sip_coffee","advance":null}
{"say":"雨这么大，总会有人来。","emotion":"calm","suggest":"glance_window","advance":"probe"}
```

**b（streamObject，数组）**

```
### g2（寒暄）
[{"say":"雨还在下。","emotion":"calm","suggest":"glance_window","advance":null},{"say":"咖啡凉了，我还没走。","emotion":"guarded","suggest":"sip_coffee","advance":"probe"}]

### w1（问她在等谁）
[{"say":"咖啡凉了。","emotion":"calm","suggest":"sip_coffee","advance":null},{"say":"一封写了三年的信。","emotion":"guarded","suggest":null,"advance":"probe"}]
```

**e（行内标签）**

```
### g2（寒暄）
[calm]不忙，就坐会儿。<act:sip_coffee>
[calm]雨这么大，你带了伞吗？<advance:probe>

### w1（问她在等谁）
[guarded]咖啡凉了，我还在等人。<act:sip_coffee>
[neutral]一个写信的人，写了三年。<advance:probe>
```

### 1.8 推荐：格式 a（逐行 JSON）

理由，按权重排序：

1. **首句延迟不输**：P50 766ms、P90 968ms，和 e（753/907）在噪声内，比 b 的 P50 差 112ms 但比 b 的 P90 好、整轮 P50 更是最好（910ms vs 933ms）。b 的 P50 优势来自「第一个数组元素很快就完整」，但代价是整轮更慢，对 Q3 这个「首句」指标只有边际收益。
2. **合规率并列满分，但 a 的结构性风险最低**：b 的合规完全靠提示词（schema 不下发），a 的合规靠提示词 + 行边界双重约束；e 要靠继承规则补语义，模型已经在样例里给出 `[neutral]` 这种「与上一句不一致但合法」的输出，语义最弱。
3. **复杂度最低**：零依赖、40 行解析器、出问题一眼能定位。b 多两个包、一个 JSON Schema、一层不完整对象语义，还踩了 `providerOptions` 键名的坑。
4. **取消三者无差别**，这一项不参与决策（都 100 分）。

补充建议（不改变结论）：

- b 的唯一潜在优势是「以后换到支持 structured outputs 的 provider 时可以用 `json_schema` 强约束」。当前 DeepSeek 不支持，所以现在选 b 属于为一个尚未存在的收益付出复杂度。
- e 可以留作「按句播放粒度更细」的备选，但它的 `say` 里混排标签，一旦模型在台词里写了方括号就需要清洗，收益不明显。

---

## 2. P2：Fish STT 对浏览器录音格式的支持 —— **被 402 阻断**

做了什么：

1. `say -v Ting-Ting` 生成 7.13s 中文语音，参考文本：
   「今天下了一整天的雨，我在这条街上等你很久了，桌上那杯咖啡已经凉了。」
2. ffmpeg 转三种容器：

   | 格式 | 文件 | 大小 | 时长 |
   |---|---|---|---|
   | webm(opus) | `out/p2/browser.webm` | 45,517 B | 7.161s |
   | mp4(aac) | `out/p2/browser.mp4` | 59,603 B | 7.133s |
   | wav | `out/p2/browser.wav` | 342,496 B | 7.134s |

3. `POST https://api.fish.audio/v1/asr`，`model: transcribe-1-pro` 头，multipart 上传（`audio` + `language=zh` + `ignore_timestamps=true`）。

结果（两轮，共 6 次调用，全部 402）：

| 格式 | 第 1 轮 | 第 2 轮 | 到错误响应耗时 |
|---|---|---|---|
| webm(opus) | 402 | 402 | 1162ms / 1018ms |
| mp4(aac) | 402 | 402 | 1342ms / 1104ms |
| wav | 402 | 402 | 397ms / 339ms |

响应体（两轮一致）：

```json
{"status":402,"message":"Insufficient API credit. API credit is managed independently from platform credit. Please visit https://fish.audio/app/developers to view your API credit balance or add funds."}
```

结论：

- **实测结论：无法判定。** 请求在鉴权之后、进入转写之前就被计费层拒绝，没有任何一条走通，所以「能否识别 webm/mp4/wav」在本账户上没有得到验证。按文档「错误响应不计费」，这 6 次不产生费用。
- `[INFERENCE]` 按官方文档，`transcribe-1-pro` **支持** WAV、MP3、AAC（含 M4A/MP4）、FLAC、Ogg、**WebM/Matroska**、MOV，并明确写了「including browser recordings」；不支持的只有 AIFF、CAF、WMA、AMR、AC-3、裸 PCM。也就是说浏览器 `MediaRecorder` 的 webm/opus 在文档口径下是支持的，但这是文档结论，不是本次实测结论。
- 未验证的细节：文件名字段、`language=zh` 是否影响、`ignore_timestamps` 的默认行为、真实 CER。

复跑方式（充值后一条命令，会覆盖同一路径的 JSON）：

```
pnpm probe:p2
```

---

## 3. P3：Fish TTS 情绪听感与首包延迟 —— **12 次只成功 1 次**

做什么：同一句台词「雨还在下，先坐吧。」，按 `apps/server/src/director/vocab.ts` 的 6 个情绪标签拼 TTS 文本（neutral 无标签、`[calm]`、`[soft tone]`、`[sad]`、`[gentle]`、`[surprised]`），`POST /v1/tts`（`format=mp3`、`mp3_bitrate=128`、`latency=normal`、`normalize=true`、`language=zh`），`model` 头 = 模型名。音色：`FISH_VOICE_ID` 为空 → **请求不带 `reference_id`，使用 Fish 默认音色**。

结果（12 次 = 6 情绪 × 2 模型）：

| 模型 | 成功 | 首字节 | 总耗时 | 说明 |
|---|---|---|---|---|
| s2.1-pro-free / sad | ✅ | **1208.1ms** | 1254.3ms | 33,017 B，实测音频 2.064s（`[sad] 雨还在下，先坐吧。`） |
| s2.1-pro-free / 其余 5 个 | ❌ | — | — | 402 |
| drama-3 / 全部 6 个 | ❌ | — | — | 402 |

- **首包延迟：只有 1 个点（1208ms），不能当分布看。** 与 D30 的「TTS 首句 0.6–1.2s」理论值刚好在上限。
- 同一次运行里 neutral 先失败、sad 成功、后面又全失败，说明不是权限或路由问题（否则不会 200），而是账户侧余额/配额在抖动；`drama-3` 一次都没过。
- 盲听页：`tools/probes/out/p3/blind.html`（纯静态，`file://` 直接打开）。当前只有 1 条成功样本，所以页面上只有 1 条；充值后重跑 `pnpm probe:p3` 会重新生成 12 条并按时间种子打乱，页面逻辑本身已用 mock 音频在真浏览器里验过（12 条、每行可播放、选完提交会算总正确率与分模型正确率、并逐条标 ✓/✗）。
- 只重排页面、不发请求：`npx tsx p3/blind-only.ts`（在 `tools/probes/` 下）。

**不做听感结论。** 哪一档情绪听起来对、`[soft tone]` / `[gentle]` 是否有可辨差异、默认音色是否合适，都由用户盲听后判断；本报告不给倾向。

---

## 4. 调用总次数

| 探针 | 计入统计 | 额外 | 合计网络调用 |
|---|---|---|---|
| P1 | 60（a 20 + b 20 + e 20） | +20（b 首轮因思考未关闭而作废，重跑一轮） | **80** |
| P2 | 6（webm/mp4/wav × 2 轮，全部 402 不计费） | 0 | **6** |
| P3 | 12（6 情绪 × 2 模型，1 次 200 计费、11 次 402） | 0 | **12** |
| 开发期连通性探针 | — | 1 次（`max_tokens=8` 的非流式小请求，确认 `thinking.disabled` 被接受、usage 里带缓存字段） | **1** |
| **总计** | | | **99 次请求**，其中 Fish 18 次里只有 1 次计费 |

budget 超支说明见 §5 第 1 条。

---

## 5. 与任务书的偏差（必须看）

1. **「20 条固定输入」与「每格式最多 20 次调用 + 每格式 3 次取消」算术上互斥**（20+3=23>20）。我的处理：每格式仍然只花 **20 次调用**——其中 **17 条输入跑全量、3 条输入（g1 / o1 / s1）只跑取消模式**。因此 `inputs.json` 是完整的 20 条、10 类全覆蓋，但**合规率矩阵的样本是 17 条而不是 20 条**，取消测试是 3 次。如果要求 20 条全量 + 3 次取消，需要把上限放宽到 23 次/格式。
2. **P1 实际花了 80 次调用**（超上限 20 次，仅 b 格式）：b 的第一轮虽然 20 次全部「解析成功」，但 `usage.reasoningTokens` 为 31–281，说明**思考模式没关**（`providerOptions` 的键写成了 `openaiCompatible`，而该 provider 的键是它的 `name`，即 `deepseek`）。这一轮数据作废，修正后重跑 b 20 次。作废数据留在 `out/p1-2026-10-26T03-56-16.json` 供核对：同一套代码，思考开着时 b 的首句 P50 是 1577ms，关掉后是 654ms——**这个 2.4× 差距就是本轮返工的原因**。
3. **P2 打了 2 轮共 6 次**：按 Fish 文档 402 不该重试，但同一次 P3 里出现 1 次 200，怀疑是余额抖动，所以用「P2 上限 6 次」内的剩余 3 次做了一次一致性确认；结论是稳定 402，不再继续。
4. **P3 没有拿满 6 情绪 × 2 模型**：上限 12 次已全部用完（11 次 402），不继续重试。
5. 提示词里的情绪/动作/剧情词表是**手抄** `packages/protocol/src/enums.ts` 与 `apps/server/src/director/vocab.ts` 的值到 `p1/persona.ts`、`p3/probe.ts`，因为要求不改 `packages/`、不新增对 `apps/server` 的依赖。`p1` 的校验仍然 import `@mira/protocol` 的 `llmBeatSchema` / `parseLlmBeatLenient` / 枚举选项，所以**校验侧不可能漂移，只有提示词文本是抄的**。

---

## 6. 对既有工程的影响

```
$ pnpm typecheck
packages/protocol typecheck: Done
tools/probes    typecheck: Done
apps/client     typecheck: Done
apps/server     typecheck: Done

$ pnpm test
 Test Files  23 passed (23)
      Tests  269 passed (269)
```

需要说明的一点：`pnpm test` 的**第一次**运行出现 `1 failed | 268 passed`，紧接着复跑 23/23、269/269 全绿；同一时间另一个 Agent 正在改 `apps/server`（`src/session.ts`、`src/index.ts`、新增 `adapters/faults.ts`）与 `packages/protocol/src/messages.ts`。本次没有修改 `apps/`、`packages/` 里的任何一行，也没有新增测试文件，所以这条波动不是本任务引入的；但它的具体是哪条断言我没有复现到（失败轮次已被后续运行覆盖）。

对仓库的唯一改动：根 `package.json` 增加 4 个 `probe:*` 脚本、`pnpm-workspace.yaml` 增加 `tools/probes`、`pnpm-lock.yaml` 更新。

---

## 7. 接口理解上不确定的地方（附文档 URL）

1. **DeepSeek 的思考开关字段**：任务书要求请求体带 `thinking: {"type": "disabled"}`。实测该字段被接受（200，且 `usage` 里 `reasoning_tokens` 消失），但我**没有在官方文档里找到这个字段的正式说明**——`https://api-docs.deepseek.com/` 是 SPA，抓不到正文，`/llms.txt` 也不存在。也就是说这是个「实测有效、文档未确认」的字段；换模型（如 `deepseek-reasoner`）时是否仍生效未验证。
2. **DeepSeek 的前缀缓存字段**：裸接口返回 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 与 `prompt_tokens_details.cached_tokens`（三处同时出现，值一致）；`@ai-sdk/openai-compatible` 只映射 `cached_tokens`。缓存命中的**门槛**（文档说按 64 token 块）没有验证——我们每次命中 128 或 256 token，正好是 64 的整数倍，与文档口径吻合，但不足以证明门槛。参考：`https://api-docs.deepseek.com/guides/kv_cache`。
3. **AI SDK 的三处行为**（都在本地 `node_modules/@ai-sdk/openai-compatible` 源码里确认，官方文档 `https://ai-sdk.dev/providers/openai-compatible-providers`）：
   - `providerOptions` 的键 = provider 的 `name`（`providerOptionsName = config.provider.split(".")[0]`），写错键会**静默丢弃**，不报错；
   - `supportsStructuredOutputs` 默认 `false` ⇒ 只发 `response_format: {"type":"json_object"}`，`json_schema` 不下发，同时打一条 `unsupported-setting` 警告；
   - 流式 usage 需要 `includeUsage: true` 才会带 `stream_options.include_usage`。
   这三条里第一条最容易踩，且**不报错**，建议以后接入真实 provider 时统一在 wrapper 里断言键名。
4. **Fish ASR 的计费边界**：`402` 的文案说「API credit 与 platform credit 相互独立」，本账户 platform 侧能登录、TTS 偶发成功，所以到底是「余额为 0」还是「免费额度按分钟限流」无法区分；`https://docs.fish.audio/api-reference/endpoint/openapi-v1/speech-to-text` 把 402 定义为不可重试，这与我们观察到的「同一分钟内一次 200」矛盾。**这是本次最不确定的一条**。
5. **Fish 是否接受了多媒体文件（webm/mp4）**：完全未验证（见 §2）。文档 `https://docs.fish.audio/api-reference/endpoint/openapi-v1/speech-to-text#supported-audio-formats` 说支持，但 402 发生在格式解码之前，所以连「格式校验有没有过」都拿不到信号。
6. **Fish 的情绪标签语法**：沿用 `vocab.ts` 的 `[calm]` / `[soft tone]` / `[sad]` / `[gentle]` / `[surprised]` 前置拼接。`https://docs.fish.audio/features/text-to-speech` 里对这些标签的**有效模型范围**（是否只有 S2 家族、`drama-3` 是否语法不同）我没有找到明确表述，本次只验证了 `s2.1-pro-free` 能对 `[sad]` 返回 200。
7. **`POST /v1/tts` 的 `model` 位置**：文档说在**请求头**（`model: s2.1-pro-free`），字段不在 body 里；body 里放 `model` 会被忽略。本次按头部实现。参考：`https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech`。

---

## 8. 明确没有做的事

- 没有 commit。
- 没有改 `docs/architecture/`（D16/D17/D29/D30/D31、Q3 只读）。
- 没有碰 `tools/live2d-pipeline/` 与 `apps/`（包括 `apps/server` 的故障注入）。
- 没有打印或写入任何 Key；错误信息统一过 `redact()`，`.env` 里的 Key 值不会出现在 `out/` 的任何文件里。
- 没有替用户下「哪个情绪的标签听起来对」的结论；P3 只交数据与盲听页。
- 没有为了凑数据重跑 P2/P3（402 已确认稳定）；P1 的重跑见 §5 第 2 条，原因是测量口径错误而非刷数据。
