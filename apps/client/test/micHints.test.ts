/**
 * freeze-fix8 §2/§3：麦克风提示纯函数单测（先写会失败的测试）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blocksMic,
  isPermissionDenied,
  isShortPress,
  micAvailability,
  readMicEnv,
  SHORT_PRESS_MS,
} from "../src/live/micHints";

describe("freeze-fix8 §2 isShortPress：短按判定", () => {
  it("按下到松开 < 300ms 判为短按", () => {
    expect(SHORT_PRESS_MS).toBe(300);
    expect(isShortPress(0)).toBe(true);
    expect(isShortPress(120)).toBe(true);
    expect(isShortPress(299)).toBe(true);
  });

  it("≥ 300ms 不是短按", () => {
    expect(isShortPress(300)).toBe(false);
    expect(isShortPress(1_500)).toBe(false);
  });

  it("非有限 / 负时长按非短按处理", () => {
    expect(isShortPress(Number.NaN)).toBe(false);
    expect(isShortPress(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isShortPress(-1)).toBe(false);
  });
});

describe("freeze-fix8 §3 micAvailability：可用性判定", () => {
  it("安全上下文 + 有 getUserMedia → 可用", () => {
    expect(micAvailability({ isSecureContext: true, hasGetUserMedia: true })).toEqual({ available: true });
  });

  it("非安全上下文 → 不可用（insecure）", () => {
    expect(micAvailability({ isSecureContext: false, hasGetUserMedia: true })).toEqual({
      available: false,
      reason: "insecure",
    });
  });

  it("没有 getUserMedia → 不可用（unsupported）", () => {
    expect(micAvailability({ isSecureContext: true, hasGetUserMedia: false })).toEqual({
      available: false,
      reason: "unsupported",
    });
  });

  it("两者都不满足 → insecure 优先（非安全上下文是线上主因）", () => {
    expect(micAvailability({ isSecureContext: false, hasGetUserMedia: false })).toEqual({
      available: false,
      reason: "insecure",
    });
  });
});

describe("freeze-fix8 §3 isPermissionDenied：NotAllowedError 判定", () => {
  it("NotAllowedError → true", () => {
    expect(isPermissionDenied(new DOMException("denied", "NotAllowedError"))).toBe(true);
  });

  it("其他错误 / 非 DOMException → false", () => {
    expect(isPermissionDenied(new DOMException("x", "NotFoundError"))).toBe(false);
    expect(isPermissionDenied(new Error("boom"))).toBe(false);
    expect(isPermissionDenied(undefined)).toBe(false);
  });
});

describe("freeze-fix8 §3 readMicEnv / blocksMic：从 window / navigator 读环境", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("没有 window（非真实浏览器）→ 不预判、不拦截", () => {
    vi.stubGlobal("window", undefined);
    expect(readMicEnv()).toBeNull();
    expect(blocksMic(null)).toBe(false);
  });

  it("安全上下文 + 有 getUserMedia → 可用、不拦截", () => {
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => {} } });
    expect(micAvailability(readMicEnv()!)).toEqual({ available: true });
    expect(blocksMic(readMicEnv())).toBe(false);
  });

  it("非安全上下文（http://<IP>）→ insecure、拦截", () => {
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => {} } });
    expect(micAvailability(readMicEnv()!)).toEqual({ available: false, reason: "insecure" });
    expect(blocksMic(readMicEnv())).toBe(true);
  });

  it("mediaDevices 缺失 → unsupported、拦截", () => {
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {});
    expect(micAvailability(readMicEnv()!)).toEqual({ available: false, reason: "unsupported" });
    expect(blocksMic(readMicEnv())).toBe(true);
  });
});
