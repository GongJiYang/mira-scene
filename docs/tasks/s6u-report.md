# S6u 执行报告：Web UI 重设计（「深夜推流」）

> 批次性质：**纯视觉**（不改行为 / 状态机 / 协议 / 服务端）。testid 只增不减。文案集中 `uiText.ts`，颜色只用 token 变量。未 commit。未运行 e2e（冻结点统一跑）。
> 设计稿源：`docs/design/s6u/*.dc.html`（以内联 style 为准）。
> 执行者：Command Code。

---

## §0 验收结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | ✅ 全绿（5 项目） |
| 单测 | `pnpm test` | ✅ 98 文件 / 969 测试全通过（含新增 `stateChip.test.ts` 5 条） |
| 冒烟 | `PROVIDER_MODE=mock pnpm smoke` | ✅ `SMOKE OK` |
| 客户端构建 | `pnpm --filter @mira/client run build` | ✅ 构建成功 |
| testid 集合 | diff before/after | ✅ **只增不减**（+5，-0） |

---

## §1 设计 token（`Tokens.dc.html`）→ 实现位置

全部落在 `apps/client/src/live/live.css` 顶部 `:root`：

- `--ink #120E1C`（底）、`--panel #1E1830`、`--panel-2 #241D3A`（标题栏）、`--line #3A2F55`、`--line-2 #4A3F68`
- `--text #F3EEFF`、`--text-2 #C8BEDF`、`--muted #A99CC4`、`--dim #8F82AD`
- `--accent #C9A7FF`、`--live #FF5FA2`、`--listen #8FD3FF`、`--think #FFC27A`、`--ok #9EF0C2`
- 字体 `--font-body`（Noto Sans SC → system-ui 回落）、`--font-mono`（VT323 → ui-monospace 回落）
- 圆角 `--radius-panel 10px`、`--radius-btn 12px`、`--radius-pill 999px`
- 字号：字幕 22（手机 18）、名字/按钮 15、弹幕 14、辅助 12 — 见各 class

**兼容做法**：旧变量名保留为别名指向新 token（`--live-bg: var(--ink)` 等），旧 class 自动换色；
零散色值（`#08060c`、`#0f0a14`、`rgba(15,10,20,…)`、`#241a2e`）逐条替换为 token。

**字体加载**（用户确认「引入但离线回落」）：`apps/client/index.html` `<head>` 加
`preconnect` + Google Fonts `<link …display=swap>`；`font-family` 已带 system-ui / monospace 回落。
离线 / 拉不到时自动回落，不影响单测（测试不渲染字体、不发网络请求）。

---

## §2 桌面布局（`Main.dc.html`）→ 组件 / CSS 对应

| 设计稿元素 | 组件 / CSS 位置 |
|---|---|
| 两列网格（左 1fr / 右 360px，行 1fr / 72px，16px 内边距） | `Live.tsx` `.live-desktop` ⨯ `live.css` `.live-desktop` |
| 去掉左侧频道栏 / 舞台下方黑边 | 删除 `.live-sidebar`、`.live-main`；`--live-sidebar-w` 移除 |
| 舞台窗口（圆角面板 + 描边） | `.live-stage-window` |
| 40px 标题栏 | `.live-stage-bar`（`data-testid="stage-bar"`） |
| 头像（24px，accent 描边） | `.live-channel`（`channel-yuna` 按钮迁入标题栏头像位） |
| 名字（15，粗） | `.live-stage-name`（`live-name`） |
| LIVE 胶囊（粉底） | `.live-badge` |
| `1 viewer · 时长`（VT323） | `.live-stage-meta`（`UI_TEXT.viewerCount` + `durationPlaceholder`） |
| 剧情标题 + 进度点 | `StoryHeader`（`story-header`/`story-title`/`story-dots`），移入标题栏 |
| 「文档」「观测」「设置」 | `LiveEntries` + `SettingsDialogDesktop` |
| 模式小标签 Mock/真实 | `ModeBadge` |
| 状态牌（右上，四态） | 新组件 `StateChip`（`state-chip`，映射见 §状态牌） |
| 字幕对话框（底部居中，≤680） | 新组件 `SubtitleBox`（`subtitle`），`.live-subtitle-box/name` |
| 兜底台词琥珀名牌「忧奈 · 网络卡了」 | `SubtitleBox` 的 `data-fallback=1` + `--think`（文案 `fallbackSpeaker`） |
| 说话时「点画面任意位置可以打断她」 | `SubtitleBox` 内 `.live-interrupt-hint`（`interrupt-hint`，仅 speaking） |
| 输入条（输入框 / 礼物 / 发送 / 按住说话胶囊） | `.live-input-bar`、`.live-input`、`.live-gift`、`.live-send`、`.live-ptt-pill` |
| 弹幕窗口（标题栏 + `CHAT · n online` + 动作表 + 四类弹幕） | `.live-chat`、`.live-chat-bar*`、`ActionPanelDesktop`、`.live-danmaku*` |
| 弹幕四种样式（普通彩色昵称 / 你 accent 粗体 / 系统 dim 居中 / 引导虚线框） | `DanmakuItem` + `.live-danmaku-nick[-user]` / `.live-danmaku-system` / `.live-danmaku-guide` |

## §3 手机布局（`MobileSpeaking` / `MobileListening`）→ 组件 / CSS 对应

| 设计稿元素 | 组件 / CSS 位置 |
|---|---|
| 全屏舞台 | `.live-mobile` / `.live-mobile-stage` |
| 顶栏：头像胶囊（名 + viewer + LIVE）+ 菜单按钮 | `.live-mobile-header` / `.live-mobile-id` / `MobileMenu`（`☰`） |
| 剧情标题胶囊 + 进度点 | `StoryHeader`（手机内 `.live-mobile-header .live-story-header` 胶囊化） |
| 状态牌（顶栏下，右上） | `StateChip`（`live.css` `.live-mobile .live-state-chip`） |
| 左下弹幕（最多 3 条，引导虚线框） | `.live-mobile-danmaku`（上限改 3） |
| 字幕（输入条上方） | `.live-mobile-subtitle` |
| 输入条：圆角输入框 + 礼物 + 60px 圆形麦克风 | `.live-mobile-input` / `.live-mobile-circle` / `.live-mobile-mic-round` |
| 按住说话录音面板（声波 / 计时 / 松开发送） | `.live-recording-panel`（`recording-panel` / `recording-timer`），波形随 `--level` |
| 菜单：文档 / 观测 / 动作表 / 设置 | `MobileMenu`（4 项，`action-toggle`/`settings-toggle`/`entry-docs`/`entry-obs`） |

## §4 设置面板（`Settings.dc.html`）→ 组件 / CSS 对应

| 设计稿元素 | 组件 / CSS 位置 |
|---|---|
| 三段式模式开关（自动 / Mock / 真实） | `SettingsPanel.tsx` `.settings-modes`/`.settings-mode`（radiogroup，当前项 accent 实底） |
| 模式说明 + 当前生效 | `.settings-mode-note`（`modeNote` + `sessionMode`） |
| 三组 Key（聊天 / 语音 / 生图）+ provider 名 | `.settings-group` / `.settings-provider` |
| 来源标签（绿服务器 / 紫你填的 / 琥珀未配置） | `SourceLabel` → `.settings-source[data-source=server\|user\|none]`（`--ok`/`--accent`/`--think`） |
| 生图未配置补「换背景用示例图」 | `SourceLabel` 的 `note`（`imageNotConfiguredNote`） |
| `type=password` + 显示切换 | `SecretInput`（未改行为） |
| 安全说明 | `.settings-note`（`privacyNote`） |
| 「清除我的 Key」「保存并重新连接」 | `.settings-clear` / `.settings-save`（`settings-clear`/`settings-save`） |
| 桌面居中对话框 / 手机底部抽屉 | `.settings-dialog`（固定居中） / `.settings-drawer` |

## §5 其它页面

| 元素 | 位置 |
|---|---|
| 文档页配色 | `apps/client/src/docs/docs.css`：`--docs-*` → token；tint 色 → accent/pink |
| 观测页配色 | `apps/client/src/obs/obs.css`：全量 → token；语义色 stt→listen、llm→accent、tts→think、play→ok、end→dim |
| 错误 / 断线提示 | `.live-error` / `.live-status`（token） |
| 截图卡片 | `.live-screenshot*`（纸质感保留，阴影 / 画布底 → token） |
| 换背景状态条 | `.live-scene-status*`（token，移至状态牌下方 `top:58px` 避免重叠） |

---

## 状态牌纯函数（关卡 3）

- 新文件 `apps/client/src/live/stateChip.ts`：`stateChipFor(phase)` → `{ tone, label }`。
  - `idle → {idle, 发呆中}`、`listening → {listen, 在听你说}`、`thinking → {think, 想一想}`、`speaking → {speak, 说话中}`、`error → idle`（无独立态，回落待机）。
- 新单测 `apps/client/test/stateChip.test.ts`（5 条）全绿。
- 组件 `StateChip`（`Live.tsx`）按 tone 上色 + 图标（灰点呼吸 / 耳朵 SVG / `···` 跳动 / 声波柱）。

---

## testid 差异（要求「只增不减」）

对比方式（改动前后各跑一次，同一命令）：

```sh
grep -rho 'data-testid="[^"]*"\|data-testid={`[^`]*`}' apps/client/src \
  | sed -E 's/data-testid=\{`(.*)`\}/data-testid="\1"/' | sort -u
```

**新增（+5）**：

- `stage-bar`（桌面舞台标题栏）
- `state-chip`（状态牌）
- `interrupt-hint`（说话时打断提示）
- `recording-panel`（手机录音面板）
- `recording-timer`（录音计时）

**移除（-0）**：无。

集合计数：before **82** → after **87**。

> 说明：`channel-yuna`、`live-name`、`story-*`、`subtitle`、`text-input`、`gift`、`ptt`、`danmaku-list`、`settings-*`、`mode-badge` 等全部仍在（仅位置 / 样式变化）。
> 不改动的 testid 承载：`docs-*`、`obs-*`、`yuna-*`、`screenshot-*`、`fx-*`、`story-video*` 等一律未触碰。

---

## 设计稿中有、但未实现的元素及原因（关卡 1 YAGNI）

| 元素 | 原因 |
|---|---|
| 字幕逐字进度（已播亮 / 未播 `--dim`） | 现有字幕状态**没有**逐字进度字段 → 整句亮显示，不为视觉改字幕逻辑。 |
| 手机录音面板「上滑取消」 | **没有**该功能 → 不显示（设计稿明确要求此时不显示）。 |
| 手机实时识别气泡 | 现有状态**没有**实时识别 → 不显示。 |
| `1 viewer` / 开播时长 `02:14:37` | 无真实数据源 → 静态占位（`UI_TEXT.viewerCount` / `durationPlaceholder`）。 |
| 礼物冷却倒计时秒数 | 无秒级订阅 → 礼物按钮保留粉色图标，冷却逻辑（`cooldowns.gift`）不变。 |
| 弹幕在线人数 `CHAT · n online` | 无真实在线数 → 用当前弹幕条数占位（`chatOnline(danmaku.items.length)`）。 |

---

## 行为未改动的确认

- 未改：`state/*`、`core/*` 决策、协议、服务端、`tools/live2d-pipeline/**`、`skills/**`。
- 交互逻辑（PTT 起止、点击打断 / 戳、引导弹幕调度、冷却、频道切换）原样。
- 设置面板仅改样式 / 结构，`saveSettings` / `clearKeys` 调用不变；`SETTINGS_TEXT` 仅**搬家**（`settings.ts` → `uiText.ts` 并再导出），键值行为不变。
- 唯一语义常量调整：手机弹幕浮层上限 `MAX_MOBILE_DANMAKU` 6 → 3（这是设计稿要求的视觉差异），同步更新了对应单测断言。
