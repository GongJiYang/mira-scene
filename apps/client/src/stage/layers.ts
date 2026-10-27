/**
 * 舞台图层合成（架构关卡 §3：必须是纯函数，写单测）。
 *
 * `composeStage(vm) → Layer[]`：把视图模型快照（phase / visual / 表演帧 / media / C 状态）
 * 映射成一组有序图层，每层含 `{ id, src, opacity, transform, z }`。
 * 本函数不做任何 I/O、不读时钟、不碰 DOM —— DOM / canvas / 计时器都在外壳层。
 *
 * 图层 id 用前缀分组，外壳据此决定渲染方式：
 * - `bg:`  背景（三态切换由外壳做淡入淡出）
 * - `fx:`  特效叠加（暖光等，非图片层）
 * - `char:` 角色分层立绘（D24，由状态机 B 驱动）
 * - `fg:`  前景桌面
 * - `photo:` 拍立得
 */
import type { FaceLayers, Fx, Hands, Media } from "@mira/protocol";
import { characterManifest } from "../render/manifest";
import type { Blink, MouthShape, StagePhaseKind } from "../state/performance";
import type { StoryMediaStatus } from "../state/storyMedia";
import type { Visual } from "../state";

export type Orientation = "portrait" | "landscape";

export type StageLayer = {
  id: string;
  /** 图片地址；非图片层（如暖光）为空串。 */
  src: string;
  /** 0–1。 */
  opacity: number;
  /** CSS transform 字符串；无变换时为 "none"。 */
  transform: string;
  /** 由小到大的叠放次序。 */
  z: number;
};

export type StageVm = {
  phase: StagePhaseKind;
  visual: Visual;
  performance: {
    face: FaceLayers;
    blink: Blink;
    mouth: MouthShape;
    hands: Hands;
    handsTransition: { from: Hands; to: Hands; progress: number } | null;
  };
  storyMedia: { status: StoryMediaStatus; media: Media | null };
  orientation: Orientation;
  /** 拍立得显影进度 0–1（外壳用 `developProgress` 得到）。 */
  develop: number;
};

/**
 * S5 §4 ②：角色的脸部框（以舞台百分比表示）——照片放大态必须避开它。
 * 定义放在 `photoRect.ts`（紧挨着消费它的几何计算），这里转出，作为角色定义的一部分。
 */
export { FACE_BOX } from "./photoRect";

/** 背景访问前缀：`apps/client/public/stage/assets` → 仓库 `assets/`。 */
export const STAGE_ASSETS = "/stage/assets";
/** 预置照片访问前缀（服务端 media.url 也用它）。 */
export const STAGE_PHOTOS = "/stage/photos";
/** S5 §5：剧情视频访问前缀。 */
export const STAGE_VIDEOS = "/stage/videos";

export function partUrl(name: string): string {
  return `${STAGE_ASSETS}/parts/${name}.png`;
}

export function photoUrl(media: Media): string {
  return media.url ?? `${STAGE_PHOTOS}/${media.id}.png`;
}

/** S5 §5：剧情视频地址。 */
export function videoUrl(media: Media): string {
  return media.url ?? `${STAGE_VIDEOS}/${media.id}.webm`;
}

/**
 * S4 遗留 ①（S5 §4）：按**舞台框**尺寸选素材，不按窗口尺寸（纯函数）。
 *
 * 舞台固定 2:3，所以对任意舞台尺寸都返回 `portrait` —— 相机所在区域不会被裁掉。
 */
export function pickStageAsset(stageWidth: number, stageHeight: number): Orientation {
  return stageHeight >= stageWidth ? "portrait" : "landscape";
}

/**
 * @deprecated 用 `pickStageAsset(舞台框尺寸)`。这个旧实现按窗口尺寸判断，桌面横屏会选错素材。
 * 保留仅为兼容既有单测（S4 行为）。
 */
export function orientationFor(width: number, height: number): Orientation {
  return pickStageAsset(width, height);
}

export type BackgroundKey = "main" | "rainstop" | "closing";

/**
 * fx（持续状态，取最新值）→ 背景。
 * warm_glow 出现在 ending（灯暗下来 + 暖光），所以落在 closing 之上再叠暖光。
 */
export function backgroundForKey(fx: Fx | null): BackgroundKey {
  switch (fx) {
    case "rain_stop":
      return "rainstop";
    case "lights_dim":
    case "warm_glow":
      return "closing";
    default:
      return "main";
  }
}

const BACKGROUND_FILE: Record<BackgroundKey, string> = {
  main: "b1_bg_main",
  rainstop: "b2_bg_rainstop",
  closing: "b3_bg_closing",
};

export function backgroundUrl(key: BackgroundKey, orientation: Orientation): string {
  const suffix = orientation === "portrait" ? "_v" : "_h";
  return `${STAGE_ASSETS}/raw/${BACKGROUND_FILE[key]}${suffix}.png`;
}

export function tableUrl(orientation: Orientation): string {
  // 竖版前景桌面在 parts/，横版在 raw/（素材来源不同，URL 前缀因此不同）。
  return orientation === "portrait" ? partUrl("fg_table_v") : `${STAGE_ASSETS}/raw/b4_fg_table_h.png`;
}

/** 倾听时前倾：整体放大 1.02、上移 4px（§5）。 */
export function characterTransform(phase: StagePhaseKind): string {
  return phase === "listening" ? "translateY(-4px) scale(1.02)" : "none";
}

function blinkPart(blink: Blink): string | null {
  if (blink === "open") return null;
  if (blink === "half") return "eyelid_half";
  return characterManifest.blink;
}

function mouthPart(mouth: MouthShape): string | null {
  return characterManifest.mouth[mouth];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function photoLayer(vm: StageVm): StageLayer | null {
  const { status, media } = vm.storyMedia;
  // S5 §5：视频不是照片——它由 `<StoryVideo>` 渲染，不能落进相纸/照片图层（否则 <img> 会 404）。
  if (media !== null && media.type === "video") return null;
  if (status === "developing" || status === "ready") {
    // 空白相纸：由外壳渲染成白色卡片（src 为空）。
    return { id: "photo:card", src: "", opacity: 1, transform: "none", z: 60 };
  }
  if (status === "shown" && media !== null) {
    return { id: "photo:image", src: photoUrl(media), opacity: clamp01(vm.develop), transform: "none", z: 60 };
  }
  return null;
}

export function composeStage(vm: StageVm): StageLayer[] {
  const layers: StageLayer[] = [];
  const charTransform = characterTransform(vm.phase);

  layers.push({
    id: "bg:main",
    src: backgroundUrl(backgroundForKey(vm.visual.fx), vm.orientation),
    opacity: 1,
    transform: "none",
    z: 0,
  });

  // 暖光：radial-gradient 层，透明度 0.25（§3）。
  if (vm.visual.fx === "warm_glow") {
    layers.push({ id: "fx:glow", src: "", opacity: 0.25, transform: "none", z: 15 });
  }

  const face = vm.performance.face;
  layers.push({ id: "char:base", src: partUrl(face.base), opacity: 1, transform: charTransform, z: 20 });
  face.overlays.forEach((name, index) => {
    layers.push({ id: `char:face:${name}`, src: partUrl(name), opacity: 1, transform: charTransform, z: 30 + index });
  });

  const blink = blinkPart(vm.performance.blink);
  if (blink !== null) {
    layers.push({ id: "char:blink", src: partUrl(blink), opacity: 1, transform: charTransform, z: 40 });
  }

  const mouth = mouthPart(vm.performance.mouth);
  if (mouth !== null) {
    layers.push({ id: "char:mouth", src: partUrl(mouth), opacity: 1, transform: charTransform, z: 41 });
  }

  // 手势：200ms 交叉淡化（D28）。
  const transition = vm.performance.handsTransition;
  if (transition !== null && transition.progress < 1) {
    layers.push({
      id: `char:hands:${transition.from}`,
      src: partUrl(characterManifest.hands[transition.from]),
      opacity: 1 - clamp01(transition.progress),
      transform: charTransform,
      z: 25,
    });
    layers.push({
      id: `char:hands:${transition.to}`,
      src: partUrl(characterManifest.hands[transition.to]),
      opacity: clamp01(transition.progress),
      transform: charTransform,
      z: 26,
    });
  } else {
    layers.push({
      id: "char:hands",
      src: partUrl(characterManifest.hands[vm.performance.hands]),
      opacity: 1,
      transform: charTransform,
      z: 25,
    });
  }

  // 前景桌面：盖住角色裁剪线以下的部分。
  layers.push({ id: "fg:table", src: tableUrl(vm.orientation), opacity: 1, transform: "none", z: 50 });

  const photo = photoLayer(vm);
  if (photo !== null) layers.push(photo);

  return layers;
}
