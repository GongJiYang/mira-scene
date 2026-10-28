/**
 * 直播间 UI 文案（S6b §4）。
 *
 * 铁律 6：UI 上的文字一律用**中性占位**，集中放在这里，方便用户替换。
 * 角色台词不在这里（它们来自角色包）。
 */
export const UI_TEXT = {
  /** 直播中标记。 */
  live: "LIVE",
  /** 固定观看人数占位（不做真实观看人数，D40 YAGNI）。 */
  viewers: "1.2K",
  /** 输入框占位。 */
  inputPlaceholder: "发条弹幕，或按住麦克风说话",
  /** 发送按钮。 */
  send: "发送",
  /** 麦克风按钮（按住说话）。 */
  mic: "按住说话",
  /** 频道栏标题。 */
  channels: "频道",
  /** 弹幕栏标题。 */
  chat: "弹幕",
  /** 切换频道按钮的无障碍标签。 */
  switchChannel: "切换频道",
  /** 关闭按钮的无障碍标签。 */
  close: "关闭",
  /** 重试按钮。 */
  retry: "重试",
  /** 连接状态占位。 */
  connecting: "连接中",
  /** 麦克风不可用提示。 */
  micUnavailable: "麦克风不可用",
  /** S6f §2：文字输入时的倾听提示。 */
  listening: "正在听",
  /** S6c §5：换背景转场状态条（中性占位）。 */
  sceneTransition: "正在换背景…",
  /** S6c §5：换背景失败 / 拒绝 / 忙时的状态条文字（保持原背景）。 */
  sceneFailed: "背景没换成",
  /** S6c §5：换背景成功后的状态条文字（短暂显示后消失）。 */
  sceneReady: "背景已换",
  /** S6g-A §3.3：reveal 截图弹窗的标签。 */
  screenshot: "截图",
  /** S6g-A §5：入口按钮——文档。 */
  docs: "文档",
  /** S6g-A §5：入口按钮——观测。 */
  obs: "观测",
  /** S6g-A §5：手机端可展开菜单的无障碍标签。 */
  menu: "菜单",
  /** S6l §5：送礼物按钮。 */
  gift: "送礼物",
  /** S6l §3：观众引导弹幕的小提示。 */
  guideHint: "点一下替你说",
  /** S6l §3：观众昵称兜底。 */
  viewerFallback: "观众",
  /** S6m §3：动作表入口 / 面板标题。 */
  actionPanel: "动作表",
  /** S6m §3：动作表入口副标题。 */
  actionPanelHint: "点一下，她就做一遍",
  /** S6m §3：动作表底部说明。 */
  actionPanelNote: "只在你这里预览，不会算作对话。她说话时按钮会暂时变灰。",
  /** S6m §3：忧奈在思考 / 说话时动作表整组禁用，禁用原因。 */
  actionSpeaking: "她在说话",
  /** S6m §3：动作表分组标题。 */
  actionGroupEmotion: "情绪",
  actionGroupAccent: "表情",
  actionGroupAction: "动作",
  actionGroupLocal: "新动作",

  // ---- S6u §2/§3：状态牌（读 phase） ----
  /** 待机。 */
  chipIdle: "发呆中",
  /** 倾听。 */
  chipListening: "在听你说",
  /** 思考。 */
  chipThinking: "想一想",
  /** 说话。 */
  chipSpeaking: "说话中",
  /** 说话态状态牌的英文系统标签。 */
  stateSpeakingEn: "SPEAKING",

  // ---- S6u §2/§3：桌面顶栏 / 字幕 / 弹幕 ----
  /** 观看人数占位（S6u：静态占位，无真实数据源）。 */
  viewerCount: "1 viewer",
  /** 说话时字幕下方的打断提示。 */
  interruptHint: "点画面任意位置可以打断她",
  /** freeze-fix5 §2.2：本轮 TTS 降级（语音暂时出不来）时字幕区附近的轻提示。 */
  ttsDegradedHint: "语音暂时出不来，先看字幕吧",
  /** 兜底台词的名牌（琥珀样式）。 */
  fallbackSpeaker: "忧奈 · 网络卡了",
  /** 主播名牌（说话中）。 */
  speakerName: "忧奈",
  /** 用户自己的弹幕昵称。 */
  you: "你",
  /** 弹幕窗口副标题（系统数字）。 */
  chatOnline: (n: number) => `CHAT · ${n} online`,
  /** 引导弹幕的小前缀。 */
  guidePrefix: "↳ ",
  /** 系统弹幕（居中、暗色）。 */
  systemDanmaku: (text: string) => `— ${text} —`,

  // ---- S6u §3：手机录音面板 ----
  /** 录音面板的松开发送提示。 */
  recordingSend: "松开发送",
} as const;

/**
 * D49 / S6n §5 → S6u §4：设置面板文案。
 * S6u 起集中到 `uiText.ts`（铁律 4：UI 文案只在这里）；`settings.ts` 再导出以保持既有引用。
 */
export const SETTINGS_TEXT = {
  /** 入口按钮 / 面板标题。 */
  title: "设置",
  modeGroup: "模式",
  modeAuto: "自动",
  modeMock: "Mock",
  modeReal: "真实",
  /** 模式说明（自动规则 + 当前生效）。 */
  modeNote: "自动：有聊天和语音的 Key 就用真实模型，否则用 Mock。",
  modeNoteCurrent: "当前：",
  /** 顶栏模式小标签。 */
  badgeMock: "Mock",
  badgeReal: "真实",
  llmGroup: "聊天",
  voiceGroup: "语音",
  imageGroup: "生图",
  llmProvider: "DeepSeek",
  voiceProvider: "Fish Audio",
  imageProvider: "OpenAI 兼容",
  deepseekKey: "填你自己的 API Key（可留空）",
  fishKey: "填你自己的 API Key（可留空）",
  fishVoiceId: "音色 ID（可选，留空用忧奈的音色）",
  imageKey: "API Key",
  imageBaseUrl: "Base URL",
  imageModel: "模型（可选）",
  show: "显示",
  hide: "隐藏",
  save: "保存并重新连接",
  clear: "清除我的 Key",
  /** 来源标签（来自 session.capabilities）。 */
  sourceServer: "服务器已配置",
  sourceUser: "使用你填的",
  sourceNone: "未配置",
  /** 生图未配置时的补充说明。 */
  imageNotConfiguredNote: "未配置 · 换背景用示例图",
  /** §5：一行安全说明。 */
  privacyNote: "Key 只保存在这台设备的浏览器里，每次连接时发给服务器使用，服务器不保存。",
  /** §2：real 缺 Key 时客户端提示（自动回落 mock）。 */
  realUnavailable: "真实模式缺少聊天 / 语音的 Key，已切回 Mock",
  /** §3：Fish Key 用不了当前音色时的客户端提示（引导填自己的音色 ID）。 */
  voiceUnavailable: "这个 Fish Key 用不了忧奈的音色，可以在设置里填自己的音色 ID",
} as const;

/** S6m §3：动作表按钮文案（按 id → 中文名）。 */
export const ACTION_LABELS = {
  // 情绪
  calm: "平静",
  guarded: "防备",
  sad: "难过",
  warm: "温暖",
  surprised: "惊讶",
  neutral: "中性",
  // 表情
  love: "爱心眼",
  heart: "飘爱心",
  shy: "脸红",
  amazed: "惊讶",
  cry: "哭",
  angry: "生气",
  black: "脸黑",
  dark: "黑眼圈",
  fly_head: "飞头",
  fly_pet: "飞宠",
  // 动作（现有）
  drink: "喝一口",
  glance: "瞄弹幕",
  phone: "看手机",
  show_item: "抱熊",
  // 新动作
  wave: "挥手",
  tail_wag: "摇尾巴",
  ear_flick: "抖耳朵",
  sway: "身体晃",
} as const;

export type ActionLabelId = keyof typeof ACTION_LABELS;

export type UiText = typeof UI_TEXT;

/**
 * §5.1：把毫秒时长格式化成 `HH:MM:SS`（小时可超过 99，仍以两位起）。
 * 负数 / 非有限值按 0 处理。纯函数，便于单测。
 */
export function formatHms(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}
