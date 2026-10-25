import { describe, expect, it } from "vitest";
import {
  beatSchema,
  parseClientMessage,
  parseServerMessage,
  sceneStateSchema,
  type Beat,
  type SceneState,
} from "../src";

const scene: SceneState = {
  node: "arrive",
  trust: 1,
  flags: ["heard_rain"],
  emotion: "calm",
  hands: "cup",
  camera: null,
  fx: "rain_heavy",
  turnCount: 0,
};

const beat: Beat = {
  seq: 0,
  say: "你来了。",
  emotion: "warm",
  hands: "polaroid",
  action: null,
  camera: "close_up",
  fx: null,
  media: null,
  story: null,
};

const envelope = (type: string, payload: unknown) => ({
  v: 1,
  type,
  sessionId: "session-1",
  turnId: 3,
  seq: 0,
  ts: 1_700_000_000_000,
  payload,
});

describe("client message envelope", () => {
  const validCases: Array<[string, unknown]> = [
    ["hello", envelope("hello", {})],
    ["hello resume", envelope("hello", { resumeSessionId: "session-0" })],
    ["text_input", envelope("text_input", { text: "你在等谁？" })],
    ["audio_input", envelope("audio_input", { mime: "audio/webm", dataBase64: "AAECAw==" })],
    ["interrupt", envelope("interrupt", { interruptedTurnId: 2 })],
    ["ping", envelope("ping", {})],
  ];

  it.each(validCases)("接受合法 %s", (type, input) => {
    const parsed = parseClientMessage(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe(type.split(" ")[0]);
  });

  const invalidCases: Array<[string, unknown]> = [
    ["hello resumeSessionId 非字符串", envelope("hello", { resumeSessionId: 7 })],
    ["text_input 空串", envelope("text_input", { text: "" })],
    ["text_input 超过 500 字", envelope("text_input", { text: "雨".repeat(501) })],
    ["audio_input 缺 dataBase64", envelope("audio_input", { mime: "audio/webm" })],
    ["interrupt 负 turnId", envelope("interrupt", { interruptedTurnId: -1 })],
    ["信封 v 不是 1", { ...envelope("hello", {}), v: 2 }],
    ["缺少 sessionId", { ...envelope("hello", {}), sessionId: undefined }],
    ["未知 type", envelope("bogus", {})],
  ];

  it.each(invalidCases)("拒绝非法 %s", (_label, input) => {
    expect(parseClientMessage(input).success).toBe(false);
  });
});

describe("server message envelope", () => {
  const validCases: Array<[string, unknown]> = [
    ["session", envelope("session", { snapshot: scene })],
    ["transcript", envelope("transcript", { text: "你在等谁" })],
    ["beat", envelope("beat", { beat })],
    ["tts_audio", envelope("tts_audio", { beatSeq: 0, mime: "audio/mpeg", dataBase64: "AAECAw==" })],
    ["turn_end done", envelope("turn_end", { reason: "done" })],
    ["turn_end interrupted", envelope("turn_end", { reason: "interrupted" })],
    ["turn_end error", envelope("turn_end", { reason: "error" })],
    ["state_snapshot", envelope("state_snapshot", { snapshot: scene })],
    ["media_ready ready", envelope("media_ready", { storyEventId: "evt-1", media: { type: "photo", id: "photo_letters", url: "https://example.test/p.jpg" }, status: "ready" })],
    ["media_ready fallback", envelope("media_ready", { storyEventId: "evt-1", media: { type: "photo", id: "photo_letters" }, status: "fallback" })],
    ["pong", envelope("pong", {})],
    ["error", envelope("error", { code: "llm_timeout", message: "迟到了", retryable: true })],
  ];

  it.each(validCases)("接受合法 %s", (type, input) => {
    const parsed = parseServerMessage(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe(type.split(" ")[0]);
  });

  const invalidCases: Array<[string, unknown]> = [
    ["session 快照非法", envelope("session", { snapshot: { ...scene, trust: 4 } })],
    ["transcript text 非字符串", envelope("transcript", { text: 5 })],
    ["beat 缺 say", envelope("beat", { beat: { ...beat, say: undefined } })],
    ["beat emotion 非法值", envelope("beat", { beat: { ...beat, emotion: "angry" } })],
    ["tts_audio beatSeq 负数", envelope("tts_audio", { beatSeq: -1, mime: "audio/mpeg", dataBase64: "" })],
    ["turn_end 未知 reason", envelope("turn_end", { reason: "finished" })],
    ["state_snapshot 快照为 null", envelope("state_snapshot", { snapshot: null })],
    ["media_ready 缺 storyEventId", envelope("media_ready", { media: { type: "photo", id: "photo_letters" }, status: "ready" })],
    ["media_ready status 非法", envelope("media_ready", { storyEventId: "evt-1", media: { type: "photo", id: "x" }, status: "pending" })],
    ["media_ready media.type 非法", envelope("media_ready", { storyEventId: "evt-1", media: { type: "image", id: "x" }, status: "ready" })],
    ["ping payload 不是对象", envelope("ping", null)],
    ["error retryable 非布尔", envelope("error", { code: "x", message: "y", retryable: "yes" })],
    ["缺少 payload", { ...envelope("session", {}), payload: undefined }],
    ["额外未知 type", envelope("heartbeat", {})],
  ];

  it.each(invalidCases)("拒绝非法 %s", (_label, input) => {
    expect(parseServerMessage(input).success).toBe(false);
  });
});

describe("schema 结构约束", () => {
  it("SceneState trust 只接受 0..3 的整数", () => {
    expect(sceneStateSchema.safeParse({ ...scene, trust: 0 }).success).toBe(true);
    expect(sceneStateSchema.safeParse({ ...scene, trust: 3 }).success).toBe(true);
    expect(sceneStateSchema.safeParse({ ...scene, trust: 4 }).success).toBe(false);
    expect(sceneStateSchema.safeParse({ ...scene, trust: 1.5 }).success).toBe(false);
  });

  it("Beat seq 必须是非负整数", () => {
    expect(beatSchema.safeParse({ ...beat, seq: 0 }).success).toBe(true);
    expect(beatSchema.safeParse({ ...beat, seq: -1 }).success).toBe(false);
  });
});
