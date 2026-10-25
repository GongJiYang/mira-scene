import type { CharacterManifest } from "@mira/protocol";

/**
 * 契约 ③：角色素材清单（D28）。
 * 只是数据：文件都在 `assets/parts/` 下，本文件不含任何渲染代码。
 * 新增 Emotion / Hands 枚举值时必须在这里补映射并出图，`test/manifest.test.ts` 会检查。
 */
const MASTER = "master_clean";

export const characterManifest: CharacterManifest = {
  emotions: {
    neutral: { base: MASTER, overlays: [] },
    calm: { base: MASTER, overlays: [] },
    guarded: { base: MASTER, overlays: ["eyelid_half"] },
    sad: { base: MASTER, overlays: ["brow_sad", "mouth_sad"] },
    warm: { base: MASTER, overlays: ["mouth_smile", "blush"] },
    surprised: { base: MASTER, overlays: ["brow_raised", "mouth_o"] },
  },
  hands: {
    cup: "arm_cup",
    polaroid: "arm_polaroid",
    camera: "arm_camera",
    phone: "arm_phone",
  },
  blink: "eyelid_closed",
  mouth: {
    closed: null,
    small: "mouth_small",
    open: "mouth_open",
  },
};
