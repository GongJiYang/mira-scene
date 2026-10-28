import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecorder } from "../src/core/recorder";

type Listener = (event: unknown) => void;

class ErroringMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }
  mimeType = "audio/webm";
  private listeners: Record<string, Listener[]> = {};
  start(): void {}
  /** 模拟错误路径：只发 error，从不发 stop。 */
  stop(): void {
    for (const listener of this.listeners.error ?? []) listener(new Event("error"));
  }
  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recorder：错误收尾", () => {
  it("MediaRecorder 触发 error → stop() 返回 null，不等待 stop 事件", async () => {
    const stream = { getTracks: () => [{ stop() {} }] };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => Promise.resolve(stream) } });
    vi.stubGlobal("MediaRecorder", ErroringMediaRecorder);

    const recorder = createRecorder();
    await expect(recorder.start()).resolves.toEqual({ started: true });
    await expect(recorder.stop()).resolves.toBeNull();
  });
});

describe("freeze-fix8 §3 recorder：start() 返回失败原因", () => {
  it("getUserMedia 抛 NotAllowedError → { started:false, reason:'denied' }", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
    });
    vi.stubGlobal("MediaRecorder", ErroringMediaRecorder);

    const recorder = createRecorder();
    await expect(recorder.start()).resolves.toEqual({ started: false, reason: "denied" });
  });

  it("getUserMedia 抛其他错误 → { started:false, reason:'unavailable' }", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: () => Promise.reject(new Error("boom")) },
    });
    vi.stubGlobal("MediaRecorder", ErroringMediaRecorder);

    const recorder = createRecorder();
    await expect(recorder.start()).resolves.toEqual({ started: false, reason: "unavailable" });
  });
});
