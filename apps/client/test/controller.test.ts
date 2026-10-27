import { beforeEach, describe, expect, it } from "vitest";
import { createController, type Intents } from "../src/core/controller";
import type { Connection } from "../src/core/connection";
import type { Recording, Recorder } from "../src/core/recorder";
import { getStageState, useConnectionStore, useDebugStore, useMicStore, useStageStore } from "../src/core/store";
import { initialState } from "../src/state";

function fakeConnection(events: string[], overrides: Partial<Connection> = {}): Connection {
  return {
    connect() {},
    disconnect() {},
    sendText(text) {
      events.push(`text:${getStageState().currentTurnId}:${text}`);
    },
    sendAudio(mime) {
      events.push(`audio:${getStageState().currentTurnId}:${mime}`);
    },
    sendInterrupt(interruptedTurnId) {
      events.push(`interrupt:${interruptedTurnId}`);
    },
    ...overrides,
  };
}

function fakeRecorder(recording: Recording | null): Recorder {
  return {
    start: () => Promise.resolve(true),
    stop: () => Promise.resolve(recording),
    level: () => 0,
  };
}

function resetStores(): void {
  useStageStore.setState(initialState, true);
  useConnectionStore.setState({ status: "open", sessionId: "session-1" });
  useMicStore.setState({ micError: null });
  useDebugStore.setState({ events: [] });
}

/** 记录 dispatch 与发送的相对顺序。 */
function setup(events: string[], recording: Recording | null = null): Intents {
  resetStores();
  const controller = createController({ connection: fakeConnection(events), recorder: fakeRecorder(recording) });
  useStageStore.subscribe((state) => {
    events.push(`dispatch:${state.phase.kind}@${state.currentTurnId}`);
  });
  return controller;
}

beforeEach(resetStores);

describe("controller：submitText", () => {
  it("speaking 时先 dispatch，再发 interrupt（旧 turnId），最后发 text_input（新 turnId）", () => {
    const events: string[] = [];
    const controller = setup(events);
    useStageStore.setState({ ...initialState, phase: { kind: "speaking", seq: 0 }, currentTurnId: 7 });
    events.length = 0;

    controller.submitText("你好");

    expect(events).toEqual(["dispatch:thinking@8", "interrupt:7", "text:8:你好"]);
    expect(getStageState().currentTurnId).toBe(8);
  });

  it("idle 时不发 interrupt", () => {
    const events: string[] = [];
    const controller = setup(events);

    controller.submitText("你好");

    expect(events).toEqual(["dispatch:thinking@1", "text:1:你好"]);
  });

  it("空白文本不发任何消息、也不 dispatch", () => {
    const events: string[] = [];
    const controller = setup(events);

    controller.submitText("   ");

    expect(events).toEqual([]);
    expect(getStageState().currentTurnId).toBe(0);
  });
});

describe("controller：PTT", () => {
  it("pttUp 发送有效录音，audio_input 使用当前 turnId 且带 base64", async () => {
    const events: string[] = [];
    const sent = Promise.withResolvers<void>();
    const recording: Recording = {
      blob: new Blob(["abc"], { type: "audio/webm" }),
      mime: "audio/webm",
      durationMs: 800,
    };
    const connection = fakeConnection(events, {
      sendAudio(mime, dataBase64) {
        events.push(`audio:${getStageState().currentTurnId}:${mime}:${dataBase64}`);
        sent.resolve();
      },
    });
    const controller = createController({ connection, recorder: fakeRecorder(recording) });

    controller.pttDown();
    expect(getStageState().phase.kind).toBe("listening");
    expect(getStageState().currentTurnId).toBe(1);

    controller.pttUp();
    await sent.promise;

    expect(events).toContain("audio:1:audio/webm:YWJj");
  });

  it("录音被丢弃（不足 300ms 或无数据）时不发送 audio_input，并回到 idle", async () => {
    const events: string[] = [];
    const controller = setup(events, null);

    controller.pttDown();
    controller.pttUp();
    // stop() 立即 resolve(null)，等两个微任务即可确定后续分支已执行完。
    await Promise.resolve();
    await Promise.resolve();

    expect(events.filter((event) => event.startsWith("audio:"))).toEqual([]);
    expect(getStageState().phase.kind).toBe("idle");
    expect(getStageState().currentTurnId).toBe(1);
  });

  it("麦克风被拒绝：phase 回到 idle，micError 有值，且不发送任何消息", async () => {
    resetStores();
    const events: string[] = [];
    const denied: Recorder = {
      start() {
        useMicStore.setState({ micError: "NotAllowedError" });
        return Promise.resolve(false);
      },
      stop: () => Promise.resolve(null),
      level: () => 0,
    };
    const controller = createController({ connection: fakeConnection(events), recorder: denied });

    controller.pttDown();
    await Promise.resolve();
    await Promise.resolve();

    expect(getStageState().phase.kind).toBe("idle");
    expect(useMicStore.getState().micError).toBe("NotAllowedError");
    expect(events).toEqual([]);
  });
});
