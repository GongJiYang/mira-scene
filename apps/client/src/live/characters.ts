/**
 * 客户端角色目录（S6b §1 / §4）。
 *
 * 客户端只需要「有哪些频道、显示名、头像、offline 兜底台词」这几项；
 * 台词与提示词仍以 `characters/<id>/content.json` 为唯一来源，这里只是把
 * **同一条 offline 台词**原样搬过来给客户端本地播放用（服务端断线时发不出消息）。
 *
 * 注意：这是 UI 层数据，不参与服务端剧本；改台词请改角色包并同步这里。
 */
import type { StoryNode } from "@mira/protocol";

export type ClientCharacter = {
  id: string;
  /** 主播名（来自 pack.displayName）。 */
  displayName: string;
  /** 频道头像（中性占位，用户可替换）。 */
  avatar: string;
  /** offline 兜底台词（来自 content.json 的 fallback.offline，原样）。 */
  offlineLine: string;
  /**
   * S6c-fix1 §2：换背景失败 / 拒绝的兜底台词（来自 content.json 的 fallback.scene_failed /
   * fallback.scene_rejected，原样）。用于客户端在空档播放本地预录兜底时显示字幕。
   */
  sceneFallbackLines: { scene_failed: string; scene_rejected: string };
  /**
   * S6l §2：剧情阶段标题（来自 content.json 每个节点的 streamTitle，原样）。
   * 直播间顶部显示；只认服务端下发的当前节点。
   */
  streamTitles: Record<StoryNode, string>;
  /**
   * S6l §3：每个节点的观众引导弹幕（来自 content.json 每个节点的 guides，原样）。
   */
  guides: Record<StoryNode, readonly string[]>;
  /**
   * S6l §4：每个节点的沉默钩子（来自 content.json 每个节点的 hook，原样；ending 为空串）。
   */
  hooks: Record<StoryNode, string>;
  /**
   * S6l §5：戳一下 / 送礼物时 Mock 的情景回应台词（来自 content.json 的 events，原样）。
   */
  eventLines: { poke: readonly string[]; gift: readonly string[] };
  /**
   * S6l-fix1 §5：思考时的反应音文件名（放在 `/characters/<id>/sfx/` 下）。
   * 空数组表示该角色没有反应音 → 不播（不回退到全局文件）。
   */
  reactionSfxFiles: readonly string[];
};

/** D43：只剩忧奈一个角色（Live2D）。 */
export const CLIENT_CHARACTERS: readonly ClientCharacter[] = [
  {
    id: "yuna",
    displayName: "忧奈",
    avatar: "/characters/yuna/avatar.png",
    offlineLine: "诶？画面卡住了……还在吗？",
    sceneFallbackLines: {
      scene_failed: "诶，背景卡住了，没换成……先凑合一下吧。",
      scene_rejected: "这个不行哦，换一个别的吧。",
    },
    streamTitles: {
      arrive: "下播后 · 推流未关",
      probe: "还有一位观众没走",
      reveal: "翻到一张老截图",
      ending: "准备关推流",
    },
    guides: {
      arrive: ["主播还没下播？", "今天是不是不太开心", "这么晚还不睡吗"],
      probe: ["之前那张老截图还在吗", "第一次开播是啥时候来着", "后台数据很惨吗"],
      reveal: ["那你还想继续播吗", "三个观众里有我吗", "要不休息一阵？"],
      ending: [],
    },
    hooks: {
      arrive: "……其实我在想一件事。",
      probe: "我手机里倒是存着一张老截图。",
      reveal: "你说，我还要继续播吗。",
      ending: "",
    },
    eventLines: {
      poke: ["干嘛戳我。", "再戳要收费了哦。"],
      gift: ["诶，谢谢你的礼物！", "下播了还送，你人也太好了吧。"],
    },
    reactionSfxFiles: ["react-hmm.mp3", "react-mm.mp3", "react-ah.mp3"],
  },
];

/** 频道栏显示的角色（D43 之后只有忧奈）。 */
export const VISIBLE_CHARACTERS: readonly ClientCharacter[] = CLIENT_CHARACTERS;

export const DEFAULT_CHANNEL_ID = (VISIBLE_CHARACTERS[0] as ClientCharacter).id;

export function findCharacter(id: string): ClientCharacter | undefined {
  return CLIENT_CHARACTERS.find((character) => character.id === id);
}

export function characterOrDefault(id: string): ClientCharacter {
  return findCharacter(id) ?? (VISIBLE_CHARACTERS[0] as ClientCharacter);
}

/** S6l-fix1 §5：反应音文件名清单（供测试 / 文档引用；实际 URL 由 `reactionSfxUrls` 拼）。 */
export const REACTION_SFX_FILES = ["react-hmm.mp3", "react-mm.mp3", "react-ah.mp3"] as const;

/**
 * S6l-fix1 §5：按角色取反应音 URL（`/characters/<id>/sfx/react-*.mp3`）。
 * 某角色没有反应音（未声明或声明为空）→ 返回空数组（不播，不回退到全局文件）。
 */
export function reactionSfxUrls(id: string): string[] {
  const character = findCharacter(id);
  if (!character) return [];
  return character.reactionSfxFiles.map((file) => `/characters/${character.id}/sfx/${file}`);
}
