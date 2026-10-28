import type { Accent, Action, Beat, Camera, Emotion, Fx, Hands, Media, ServerMessage, StoryNode } from "@mira/protocol";

export type Phase =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "thinking" }
  | { kind: "speaking"; seq: number }
  | { kind: "error"; code: string; message: string; retryable: boolean };

export type Visual = {
  emotion: Emotion;
  hands: Hands;
  action: Action | null;
  camera: Camera | null;
  fx: Fx | null;
  /** D47：当前 beat 的语境表情（null 表示无额外表情）。 */
  accent: Accent | null;
};

export type ClientState = {
  phase: Phase;
  currentTurnId: number;
  queue: Beat[];
  turnEnded: boolean;
  subtitle: string | null;
  visual: Visual;
  media: Media | null;
  audioStopToken: number;
  /** S6l §2：当前剧情节点（只认服务端下发的 snapshot / beat.story，客户端不自己推断）。 */
  node: StoryNode;
  /**
   * freeze-fix5 §2.2：报过 `tts_degraded` 的轮次（无则 null）。
   * 只对**当前轮**（与 currentTurnId 相等）生效：本轮 TTS 降级 → 无声 beat 按可读时长停留并显示轻提示；
   * turn_end / 下一轮开始时清除。迟到旧轮的 tts_degraded 不写入（D3）。
   */
  ttsDegradedTurnId: number | null;
};

export type ClientAction =
  | { type: "PTT_DOWN" }
  | { type: "PTT_UP" }
  | { type: "SUBMIT_TEXT" }
  | { type: "NUDGE" }
  | { type: "SERVER_MESSAGE"; message: ServerMessage }
  | { type: "BEAT_AUDIO_STARTED"; turnId: number; seq: number }
  | { type: "BEAT_AUDIO_ENDED"; turnId: number; seq: number }
  | { type: "INPUT_CANCELLED"; turnId: number }
  | { type: "RETRY" }
  /** S6b §4：切换频道 —— 整台状态机回到初始值（不保留聊天记录）。 */
  | { type: "RESET" };
