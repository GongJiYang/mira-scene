/**
 * 客户端角色目录（S6b §1 / §4）。
 *
 * 客户端只需要「有哪些频道、显示名、头像、offline 兜底台词」这几项；
 * 台词与提示词仍以 `characters/<id>/content.json` 为唯一来源，这里只是把
 * **同一条 offline 台词**原样搬过来给客户端本地播放用（服务端断线时发不出消息）。
 *
 * 注意：这是 UI 层数据，不参与服务端剧本；改台词请改角色包并同步这里。
 */
export type ClientCharacter = {
  id: string;
  /** 主播名（来自 pack.displayName）。 */
  displayName: string;
  /** 频道头像（中性占位，用户可替换）。 */
  avatar: string;
  /** offline 兜底台词（来自 content.json 的 fallback.offline，原样）。 */
  offlineLine: string;
  /** 渲染器种类：决定舞台用分层立绘还是 Live2D。 */
  renderer: "layered" | "live2d";
  /** S6f §1：隐藏角色——不出现在频道栏、不参与切换；条目保留以便显式加载。 */
  hidden?: boolean;
};

export const CLIENT_CHARACTERS: readonly ClientCharacter[] = [
  {
    id: "rin",
    displayName: "夏凛",
    avatar: "/stage/assets/parts/master_clean.png",
    offlineLine: "……喂？好像断线了。",
    renderer: "layered",
    hidden: true,
  },
  {
    id: "yuna",
    displayName: "忧奈",
    avatar: "/characters/yuna/avatar.png",
    offlineLine: "诶？画面卡住了……还在吗？",
    renderer: "live2d",
  },
];

/** S6f §1：频道栏只显示未隐藏角色。 */
export const VISIBLE_CHARACTERS: readonly ClientCharacter[] = CLIENT_CHARACTERS.filter((character) => !character.hidden);

export const DEFAULT_CHANNEL_ID = (VISIBLE_CHARACTERS[0] as ClientCharacter).id;

export function findCharacter(id: string): ClientCharacter | undefined {
  return CLIENT_CHARACTERS.find((character) => character.id === id);
}

export function characterOrDefault(id: string): ClientCharacter {
  return findCharacter(id) ?? (VISIBLE_CHARACTERS[0] as ClientCharacter);
}
