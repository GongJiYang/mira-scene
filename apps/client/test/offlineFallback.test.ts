import { describe, expect, it } from "vitest";
import {
  fallbackVoiceUrl,
  initialOfflineState,
  installOfflineFallback,
  offlineDecision,
  type OfflineState,
} from "../src/core/fallback";
import type { ConnectionStatus } from "../src/core/store";

/**
 * S6b §2：offline 兜底只在断线时播一次；重连成功不重复播放。
 * 纯函数 `offlineDecision` 覆盖决策，`installOfflineFallback` 覆盖接线（用假 store 驱动）。
 */

describe("offlineDecision：只播一次", () => {
  it("首次进入 reconnecting → 播一次", () => {
    const decision = offlineDecision(initialOfflineState, "reconnecting");
    expect(decision.play).toBe(true);
    expect(decision.state.played).toBe(true);
  });

  it("同一次断线期间再次 reconnecting → 不再播", () => {
    const first = offlineDecision(initialOfflineState, "reconnecting");
    const second = offlineDecision(first.state, "reconnecting");
    expect(second.play).toBe(false);
    expect(second.state.played).toBe(true);
  });

  it("重连成功（open）→ 不播，并复位 played", () => {
    const played: OfflineState = { played: true };
    const decision = offlineDecision(played, "open");
    expect(decision.play).toBe(false);
    expect(decision.state.played).toBe(false);
  });

  it("重连成功后再次断线 → 可以再播一次", () => {
    const afterOpen = offlineDecision({ played: true }, "open");
    const again = offlineDecision(afterOpen.state, "reconnecting");
    expect(again.play).toBe(true);
  });

  it("首次连接（connecting）不算断线，不播", () => {
    const decision = offlineDecision(initialOfflineState, "connecting");
    expect(decision.play).toBe(false);
    expect(decision.state.played).toBe(false);
  });
});

describe("installOfflineFallback：接线", () => {
  /** 极简可订阅 store，模拟 useConnectionStore。 */
  function fakeStore(initial: ConnectionStatus) {
    let status = initial;
    const listeners = new Set<(slice: { status: ConnectionStatus }) => void>();
    return {
      getState: () => ({ status }),
      subscribe: (listener: (slice: { status: ConnectionStatus }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set(next: ConnectionStatus) {
        status = next;
        for (const listener of listeners) listener({ status });
      },
    };
  }

  it("断线 → 播一次本地音频并显示字幕；重连成功清字幕且不重播", () => {
    const store = fakeStore("open");
    const played: string[] = [];
    const subtitles: Array<string | null> = [];

    const unsubscribe = installOfflineFallback({
      characterId: () => "rin",
      offlineLine: () => "……喂？好像断线了。",
      playAudio: (url) => played.push(url),
      showSubtitle: (text) => subtitles.push(text),
      store,
    });

    store.set("reconnecting");
    store.set("reconnecting");
    store.set("open");

    expect(played).toEqual(["/characters/rin/voice/fallback/offline.mp3"]);
    // 安装时的初始 open 会先清一次字幕；断线显示台词；重连成功再清空。
    expect(subtitles).toEqual([null, "……喂？好像断线了。", null]);
    unsubscribe();
  });

  it("重连后再次断线 → 再播一次（每次断线各一次）", () => {
    const store = fakeStore("open");
    const played: string[] = [];
    installOfflineFallback({
      characterId: () => "yuna",
      offlineLine: () => "诶？画面卡住了……还在吗？",
      playAudio: (url) => played.push(url),
      showSubtitle: () => undefined,
      store,
    });

    store.set("reconnecting");
    store.set("open");
    store.set("reconnecting");

    expect(played).toEqual([
      "/characters/yuna/voice/fallback/offline.mp3",
      "/characters/yuna/voice/fallback/offline.mp3",
    ]);
  });

  it("语音路径按角色与类别拼（S6b §2 / §5 的放置约定）", () => {
    expect(fallbackVoiceUrl("rin", "offline")).toBe("/characters/rin/voice/fallback/offline.mp3");
    expect(fallbackVoiceUrl("yuna", "stt_failed")).toBe("/characters/yuna/voice/fallback/stt_failed.mp3");
  });
});
