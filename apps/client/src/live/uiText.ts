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
  inputPlaceholder: "<输入框占位>",
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
} as const;

export type UiText = typeof UI_TEXT;
