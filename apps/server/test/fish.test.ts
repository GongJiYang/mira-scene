import { describe, expect, it } from "vitest";
import { withSttErrorDegrade } from "../src/adapters/fish/degrade";
import { FishApiError } from "../src/adapters/fish/errors";
import { createFishStt } from "../src/adapters/fish/fishStt";
import { createFishTts } from "../src/adapters/fish/fishTts";
import type { LogRecord } from "../src/log";

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return handler(url, requestInit);
  }) as unknown as typeof fetch;
}

function audioResponse(bytes = 8): Response {
  return new Response(Buffer.alloc(bytes), { status: 200, headers: { "content-type": "audio/mpeg" } });
}

const SIGNAL = new AbortController().signal;

describe("Fish TTS（§3）", () => {
  it("请求体字段：text / format=mp3 / mp3_bitrate / latency=balanced / reference_id", async () => {
    const calls: Call[] = [];
    const tts = createFishTts({
      baseUrl: "https://api.fish.audio/v1",
      apiKey: "k",
      voiceId: "voice-1",
      model: "s2.1-pro-free",
      fetch: fakeFetch(() => audioResponse(), calls),
    });
    const result = await tts.synthesize("[calm] 雨还在下。", { emotion: "calm" }, SIGNAL);

    expect(result.mime).toBe("audio/mpeg");
    expect(result.data.byteLength).toBe(8);
    const call = calls[0];
    expect(call?.url).toBe("https://api.fish.audio/v1/tts");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.signal).toBe(SIGNAL);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k");
    expect(headers.model).toBe("s2.1-pro-free");
    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ text: "[calm] 雨还在下。", format: "mp3", latency: "balanced", reference_id: "voice-1" });
    expect(typeof body.mp3_bitrate).toBe("number");
  });

  it("voiceId 为空时不传 reference_id", async () => {
    const calls: Call[] = [];
    const tts = createFishTts({ baseUrl: "https://api.fish.audio/v1", apiKey: "k", voiceId: "", model: "m", fetch: fakeFetch(() => audioResponse(), calls) });
    await tts.synthesize("好", { emotion: "neutral" }, SIGNAL);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect("reference_id" in body).toBe(false);
  });

  it("402 → 抛 fish_credit；置位后不再发起请求", async () => {
    const calls: Call[] = [];
    const tts = createFishTts({
      baseUrl: "https://api.fish.audio/v1",
      apiKey: "k",
      voiceId: "",
      model: "m",
      fetch: fakeFetch(() => new Response("no credit", { status: 402 }), calls),
    });
    await expect(tts.synthesize("好", { emotion: "neutral" }, SIGNAL)).rejects.toMatchObject({ code: "fish_credit" });
    await expect(tts.synthesize("好", { emotion: "neutral" }, SIGNAL)).rejects.toBeInstanceOf(FishApiError);
    expect(calls).toHaveLength(1);
  });

  it("429 → 抛 fish_rate", async () => {
    const tts = createFishTts({
      baseUrl: "https://api.fish.audio/v1",
      apiKey: "k",
      voiceId: "",
      model: "m",
      fetch: fakeFetch(() => new Response("busy", { status: 429 })),
    });
    await expect(tts.synthesize("好", { emotion: "neutral" }, SIGNAL)).rejects.toMatchObject({ code: "fish_rate" });
  });

  it("abort：底层 fetch 抛 AbortError 时原样向上抛", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const tts = createFishTts({
      baseUrl: "https://api.fish.audio/v1",
      apiKey: "k",
      voiceId: "",
      model: "m",
      fetch: fakeFetch(() => Promise.reject(abortError)),
    });
    await expect(tts.synthesize("好", { emotion: "neutral" }, SIGNAL)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("s3-fix §4：余额耗尽的标记在成功一次后清除；每 5 分钟允许探测一次真实请求", async () => {
    const calls: Call[] = [];
    let nowMs = 0;
    let status = 402;
    const tts = createFishTts({
      baseUrl: "https://api.fish.audio/v1",
      apiKey: "k",
      voiceId: "",
      model: "m",
      now: () => nowMs,
      creditProbeIntervalMs: 5 * 60 * 1000,
      fetch: fakeFetch(() => (status === 402 ? new Response("no credit", { status: 402 }) : audioResponse()), calls),
    });

    await expect(tts.synthesize("好", { emotion: "neutral" }, SIGNAL)).rejects.toMatchObject({ code: "fish_credit" });
    expect(calls).toHaveLength(1);

    // 间隔未到：直接抛，不再发请求。
    nowMs += 60_000;
    await expect(tts.synthesize("好", { emotion: "neutral" }, SIGNAL)).rejects.toMatchObject({ code: "fish_credit" });
    expect(calls).toHaveLength(1);

    // 间隔到达：允许探测一次真实请求；成功 → 清除标记。
    nowMs += 5 * 60 * 1000;
    status = 200;
    const result = await tts.synthesize("好", { emotion: "neutral" }, SIGNAL);
    expect(result.mime).toBe("audio/mpeg");
    expect(calls).toHaveLength(2);

    // 已清除：立即再请求也直接发起。
    await tts.synthesize("好", { emotion: "neutral" }, SIGNAL);
    expect(calls).toHaveLength(3);
  });
});

describe("Fish STT（§3）", () => {
  it("请求构造：/asr、模型 transcribe-1-pro、原样转发 mime、language=zh", async () => {
    const calls: Call[] = [];
    const stt = createFishStt({
      baseUrl: "https://api.fish.audio/v1",
      apiKey: "k",
      fetch: fakeFetch(() => new Response(JSON.stringify({ text: "你在等谁？" }), { status: 200 }), calls),
    });
    const text = await stt.transcribe({ mime: "audio/webm;codecs=opus", data: Buffer.from("fake") }, SIGNAL);

    expect(text).toBe("你在等谁？");
    const call = calls[0];
    expect(call?.url).toBe("https://api.fish.audio/v1/asr");
    expect(call?.init.signal).toBe(SIGNAL);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k");
    expect(headers.model).toBe("transcribe-1-pro");
    const form = call?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("language")).toBe("zh");
    const file = form.get("audio");
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe("audio/webm;codecs=opus");
  });

  it("402 → 抛 fish_credit", async () => {
    const stt = createFishStt({ baseUrl: "https://api.fish.audio/v1", apiKey: "k", fetch: fakeFetch(() => new Response("no credit", { status: 402 })) });
    await expect(stt.transcribe({ mime: "audio/webm", data: Buffer.from("x") }, SIGNAL)).rejects.toMatchObject({ code: "fish_credit" });
  });

  it("withSttErrorDegrade：402 → 返回空串（走「没听清」），其它错误原样抛", async () => {
    const records: LogRecord[] = [];
    const credit = createFishStt({ baseUrl: "https://api.fish.audio/v1", apiKey: "k", fetch: fakeFetch(() => new Response("no credit", { status: 402 })) });
    const degraded = withSttErrorDegrade(credit, { log: (record) => records.push(record) });
    expect(await degraded.transcribe({ mime: "audio/webm", data: Buffer.from("x") }, SIGNAL)).toBe("");
    expect(records.some((record) => record.event === "provider_fallback")).toBe(true);

    const broken = createFishStt({ baseUrl: "https://api.fish.audio/v1", apiKey: "k", fetch: fakeFetch(() => new Response("boom", { status: 500 })) });
    const passthrough = withSttErrorDegrade(broken);
    await expect(passthrough.transcribe({ mime: "audio/webm", data: Buffer.from("x") }, SIGNAL)).rejects.toThrow("500");
  });
});
