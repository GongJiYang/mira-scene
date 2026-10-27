# mira-scene · 会话约定

@PROGRESS.md

## 每次会话
- **开头**：按 `session-handoff` skill 的「接续」流程，第一条回复报告【当前位置】、▶下一步、阻塞项，然后直接做下一步。
- **结尾 / 每批提交后 / 用户说要 /new、/clear、compact**：按「存档」流程整份重写 PROGRESS.md（≤60 行）。
- 写代码前一律走 `mira-code-gate`；消息开头标【批次 · 关卡 n/9 · 名称】。

## 铁律
- Claude 不写业务代码：由 Command Code（命令 `cmd`）的 DeepSeek 执行，所有代码都交给它写，Claude 负责审核、验收、提交。
- 架构结论写进 `docs/architecture/decisions.md`；AI 协作的素材写进 `docs/ai-usage-log.md`。
- 服务端自己的 Key 只从 `.env` 读取；访问者在界面填的 Key 只在其会话内存中使用（D49）；任何 Key 都不得打印、写进日志、文件或回传客户端；测试里不发真实网络请求。
- 余额/额度不在项目讨论范围：不做代码级降级方案，发现余额不足只提醒用户。
- 不替用户写文案；思路要发散；自己做判断，并注明假设。

## 常用命令
`pnpm test` · `pnpm typecheck` · `pnpm smoke` · `pnpm e2e` · `pnpm smoke:real`（需要有余额）
