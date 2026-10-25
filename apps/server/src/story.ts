import type { Beat, SceneState, StoryNode } from "@mira/protocol";

/** allowlist 转移：每轮最多前进一步由 session.ts 保证。 */
const NEXT_NODE: Record<StoryNode, StoryNode | null> = {
  arrive: "probe",
  probe: "reveal",
  reveal: "ending",
  ending: null,
};

export function createInitialScene(): SceneState {
  return {
    node: "arrive",
    trust: 0,
    flags: [],
    emotion: "neutral",
    pose: "sit",
    camera: null,
    fx: null,
    turnCount: 0,
  };
}

export type StoryDecision = { ok: true; node: StoryNode } | { ok: false; reason: string };

export function evaluateStoryAdvance(scene: SceneState, advance: StoryNode): StoryDecision {
  const next = NEXT_NODE[scene.node];
  if (next === null) {
    return { ok: false, reason: `node ${scene.node} 已是终点` };
  }
  if (advance !== next) {
    return { ok: false, reason: `不允许 ${scene.node} → ${advance}，只允许 ${scene.node} → ${next}` };
  }
  return { ok: true, node: advance };
}

export function advanceScene(scene: SceneState, node: StoryNode): SceneState {
  return { ...scene, node, trust: Math.min(scene.trust + 1, 3) };
}

/** 持久视觉状态：emotion/pose 每 beat 覆盖，camera/fx 仅在给出时覆盖。 */
export function applyBeatToScene(scene: SceneState, beat: Beat): SceneState {
  return {
    ...scene,
    emotion: beat.emotion,
    pose: beat.pose,
    camera: beat.camera ?? scene.camera,
    fx: beat.fx ?? scene.fx,
  };
}
