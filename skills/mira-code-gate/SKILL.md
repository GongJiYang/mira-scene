---
name: mira-code-gate
description: >
  mira-scene 项目每一批代码开工前必须走的「架构关卡」。先和用户一起过一遍 SDFrame 里 5 个固定的代码架构框架
  （YAGNI、端口/适配器、函数式核心、契约式设计、测试奖杯），讨论出结论后，再写任务说明交给 Command Code（cmd）
  的 DeepSeek 去写代码，最后验收、提交。每条消息都要标出阶段编号。适用场景：用户说「开始写 S3/S4…」「派发下一批」
  「写代码」「下一批」，或者任何需要为 mira-scene 写新代码的时候。
---

# Mira 代码关卡（每一批都要走）

## 阶段编号（每条消息开头必须带上）
格式：**【批次 · 关卡 n/9 · 名称】**，例如 `【S3 · 关卡 2/9 · 端口/适配器】`。如果一条消息里一起讨论了好几个关卡，就写成 `【S3 · 关卡 1–5/9 · 架构过审】`。

| 关卡 | 内容 | 谁来做 |
|---|---|---|
| 1/9 | **YAGNI**：列出本批任务，砍掉现在用不上的东西 | Claude 提出 → 用户确认 |
| 2/9 | **端口/适配器**：新代码接到哪个端口上？会不会碰到核心？ | 同上 |
| 3/9 | **函数式核心 / 命令式外壳**：哪些是纯函数（必须单测），哪些是副作用外壳 | 同上 |
| 4/9 | **契约式设计**：新边界的前置条件、后置条件、不变量，以及谁违约就怪谁 | 同上 |
| 5/9 | **测试奖杯**：类型检查、单测、集成测试、端到端测试各放多少；真实网络只出现在哪里 | 同上 |
| 6/9 | 汇总结论 → 写 `docs/tasks/<批次>.md`（每条结论都要写进去）→ **用户确认** | Claude |
| 7/9 | 派发：Command Code（cmd）的 DeepSeek（见下方命令） | Claude |
| 8/9 | 验收：自己重跑 test、typecheck、smoke，阅读关键代码，对照关卡 1–5 的结论逐条核对 | Claude |
| 9/9 | 提交，更新 `docs/ai-usage-log.md`；按 `session-handoff` 存档，重写 `PROGRESS.md` | Claude |

关卡 1–5 **合并成一条消息**：每个框架只问 1 个关键问题，并附上 Claude 的建议答案，用户一次性回复即可。用户回答「可以」或「批准」，就按建议执行。

## 五个固定框架（SDFrame）
| 框架 | slug | 在本项目里要问的问题 |
|---|---|---|
| YAGNI | `yagni-principle` | 这一批里有没有「以后可能用得上」的东西？有就砍掉，或者挪到后面的批次 |
| 端口/适配器 | `ports-and-adapters` | 外部服务（Fish、DeepSeek、生图、浏览器 API）都只能通过端口接入吗？Mock 模式还能完整运行吗（Q10）？ |
| 函数式核心 / 命令式外壳 | `functional-core-imperative-shell` | 决策逻辑（解析、规则、状态转移）是不是纯函数？I/O 有没有被挤到最外层？ |
| 契约式设计 | `design-by-contract` | 新边界上，输入非法时是降级还是报错？谁负责校验？要不要用 fast-check 做属性测试？ |
| 测试奖杯 | `testing-trophy` | 用哪一层测试来保证正确性？测试里会不会出现真实网络或真实 Key？smoke 要覆盖什么？ |

每次讨论前都要读一遍框架原文：`~/.claude/skills/sdframe/references/frameworks/<slug>.md`，重点看 When NOT 那一节，判断这一批适不适用；不适用要写明理由。

## 派发命令（关卡 7/9）
```bash
cd ~/mira-scene && cmd -p "请完整阅读 docs/tasks/<批次>.md 并严格执行……" \
  -m deepseek/deepseek-v4-flash --skip-onboarding --trust --yolo --tools-all --max-turns 400 \
  < /dev/null > docs/tasks/.<批次>-cmd.log 2>&1      # 用后台方式运行；cmd 即 Command Code（用户口中的 command go）
```
每份任务说明里都必须包含：铁律（冲突时停下报告；不许改也不许绕过；Key 只从 .env 读取、不得打印；不准 commit）、授权范围、引用的 Q 编号，以及关卡 1–5 的结论。

## 验收清单（关卡 8/9）
1. `pnpm test`、`pnpm typecheck`、`pnpm smoke` 都要自己重跑一遍，不能只看报告。
2. `git diff` 检查授权范围之外有没有改动；修改测试时只允许改字面值，不能改测试的意图。
3. 用 grep 检查仓库里有没有泄露 Key（只统计数量，不打印内容）。
4. 关卡 1–5 的每条结论，都要在代码里找到对应的实现。
5. DeepSeek 报告里提到的歧义，由 Claude 裁定，写进 decisions.md。
