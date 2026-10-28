# 文档地图

按读者分四类。评审只需要看第一类，其余是过程和素材，留着用来说明「这些结论是怎么来的」。

## 1. 评审先看
| 文档 | 内容 |
|---|---|
| [`../README.md`](../README.md) | 启动、系统结构、打断流程、指令设计、第三方服务、取舍、已知问题、投入时间、两周演进 |
| [`../AI_USAGE.md`](../AI_USAGE.md) | AI 工具、分工、人工验证、修正示例 |
| [`architecture/00-导读.md`](architecture/00-导读.md) | 题目六项要求逐条对照：怎么做、为什么、在哪看 |

## 2. 架构细节
| 文档 | 内容 |
|---|---|
| [`architecture/decisions.md`](architecture/decisions.md) | 决策记录 D1–D49（语境、选项、代价）；D24–D37 中的夏凛 / 拍立得属于早期方案 |
| [`architecture/core-truths.md`](architecture/core-truths.md) | 第一性原理：四条不可再分的事实 |
| [`architecture/quality-scenarios.md`](architecture/quality-scenarios.md) | 质量属性场景 Top 5 |
| [`architecture/challenges.md`](architecture/challenges.md) | 对两条默认假设的挑战（轮次制、LLM 直接出指令） |
| [`architecture/后续方向.md`](architecture/后续方向.md) | 交付 v1.1、AI 视频 → Live2D 动作管线（首尾闭环 + 渲染比对拟合）、平台与玩法方向 |
| [`architecture/live2d-pipeline.md`](architecture/live2d-pipeline.md) | AI 自动化 Live2D 流水线：做法、迭代记录、为什么没有用于交付 |
| [`deploy.md`](deploy.md) | 部署到服务器（systemd + Caddy） |

## 3. 制作素材
| 文档 | 内容 |
|---|---|
| [`assets-spec.md`](assets-spec.md) | 早期角色夏凛的原画需求与生图提示词 |
| [`live2d-ref-pack.md`](live2d-ref-pack.md) | Live2D 隐藏区域参考包的生图提示词 |
| [`voice-pack.md`](voice-pack.md) | 预录语音包清单（Mock 模式与兜底语音） |
| [`design/s6u/`](design/s6u/) | 直播间 UI 设计稿源文件 |
| `../characters/yuna/` | 角色包：人设提示词、剧情视觉表、语音包清单 |

## 4. 过程记录
| 文档 | 内容 |
|---|---|
| [`architecture/discussion.md`](architecture/discussion.md) | 11 轮架构讨论记录（每轮用一个设计框架） |
| [`architecture/roadmap.md`](architecture/roadmap.md) | 2026-10-26 的阶段计划（历史文档） |
| [`ai-usage-log.md`](ai-usage-log.md) | 每批 AI 协作的原始记录（`AI_USAGE.md` 的素材） |
| [`tasks/`](tasks/) | 每一批的任务说明 `<批>.md` 和执行报告 `<批>-report.md`，按时间排：stage-1/2 → g1 → s3 → s4 → s5 → s6a … s6u → freeze-fix1 |
| [`checklist.md`](checklist.md) | 已并入导读，只留指向 |
