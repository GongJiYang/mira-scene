/**
 * S6b §5.5：真实生图适配器 + 提示词组装测试。
 * 全部注入假 fetch，不发真实网络请求（铁律 2）。
 */
import { describe, expect, it } from "vitest";
import { buildImagePrompt } from "../src/adapters/media/imagePrompt";
import { createImageGenMedia, generateImage } from "../src/adapters/media/imageGen";
import type { LLMHistoryEntry, MediaContext } from "../src/ports";
import { testPack } from "./helpers/pack";

describe("buildImagePrompt（S6b §5.5 纯函数）", () => {
  it("把 {{conversation}} 替换为最近 3 轮对话摘要", () => {
    const pack = testPack("rin");
    const history: LLMHistoryEntry[] = [
      { role: "user", text: "第1问" },
      { role: "assistant", text: "第1答" },
      { role: "user", text: "第2问" },
      { role: "assistant", text: "第2答" },
      { role: "user", text: "第3问" },
      { role: "assistant", text: "第3答" },
      { role: "user", text: "第4问" },
      { role: "assistant", text: "第4答" },
    ];
    const out = buildImagePrompt(pack, history);
    expect(out).not.toContain("{{conversation}}");
    // 只保留最近 3 轮（第2–4 轮），最早一轮被截掉。
    expect(out).toContain("观众：第2问");
    expect(out).toContain("主播：第4答");
    expect(out).not.toContain("第1问");
    expect(out).not.toContain("第1答");
    // 角色包模板主体原样保留。
    expect(out).toContain("polaroid");
  });

  it("空历史用占位说明，不留空模板", () => {
    const pack = testPack("yuna");
    const out = buildImagePrompt(pack, []);
    expect(out).not.toContain("{{conversation}}");
    expect(out).toContain("（还没有对话）");
    expect(out).toContain("webcam screenshot");
  });

  it("不足 3 轮时全部保留", () => {
    const pack = testPack("rin");
    const out = buildImagePrompt(pack, [
      { role: "user", text: "你好" },
      { role: "assistant", text: "雨还在下" },
    ]);
    expect(out).toContain("观众：你好");
    expect(out).toContain("主播：雨还在下");
  });

  it("S6b-fix1 §4：单条对话超过 80 字被截断", () => {
    const pack = testPack("rin");
    const long = "你".repeat(200);
    const out = buildImagePrompt(pack, [
      { role: "user", text: long },
      { role: "assistant", text: "短答" },
    ]);
    // 80 字 + 省略号，不含完整 200 字。
    expect(out).toContain("你".repeat(80));
    expect(out).not.toContain("你".repeat(81));
    expect(out).toContain("主播：短答");
  });
});

describe("imageGen 适配器（假 fetch）", () => {
  const media = { type: "photo" as const, id: "photo_test" };
  const base = { baseUrl: "http://fake.local/v1", apiKey: "sk-test", model: "gpt-image-2.5-sunburst" };

  it("成功：取 b64_json 落盘并返回 /generated/<id>.png", async () => {
    const png = Buffer.from("fake-png-bytes").toString("base64");
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200 })) as typeof fetch;
    const result = await generateImage({
      ...base,
      prompt: "p",
      media,
      fetchImpl,
      outDir: "/tmp/mira-imagegen-test",
    });
    expect(result.status).toBe("ready");
    expect(result.url).toBe("/generated/photo_test.png");
  });

  it("HTTP 错误：按契约抛错", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(
      generateImage({ ...base, prompt: "p", media, fetchImpl, outDir: "/tmp/mira-imagegen-test" }),
    ).rejects.toThrow("HTTP 500");
  });

  it("返回缺 b64_json：按契约抛错", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{}] }), { status: 200 })) as typeof fetch;
    await expect(
      generateImage({ ...base, prompt: "p", media, fetchImpl, outDir: "/tmp/mira-imagegen-test" }),
    ).rejects.toThrow("b64_json");
  });

  it("中止：preset 在 signal 已中止时立即抛 AbortError", async () => {
    const port = createImageGenMedia({ ...base, fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch });
    const ctx: MediaContext = { pack: testPack("rin"), history: [] };
    const controller = new AbortController();
    controller.abort();
    await expect(port.preset(media, ctx, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("prompt 用到本轮之前的对话（S6b-fix1 §4）", async () => {
    let captured = "";
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)).prompt as string;
      const png = Buffer.from("x").toString("base64");
      return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200 });
    }) as typeof fetch;
    const port = createImageGenMedia({ ...base, fetchImpl, outDir: "/tmp/mira-imagegen-test" });
    const ctx: MediaContext = {
      pack: testPack("rin"),
      history: [
        { role: "user", text: "最近的一句话" },
        { role: "assistant", text: "角色的回答" },
      ],
    };
    await port.preset(media, ctx, new AbortController().signal);
    expect(captured).toContain("最近的一句话");
    expect(captured).toContain("角色的回答");
    expect(captured).not.toContain("{{conversation}}");
  });

  it("外层 signal 中止进行中的 fetch（S6b-fix1 §4）", async () => {
    const fetchImpl = (( _url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = generateImage({ ...base, prompt: "p", media, fetchImpl, outDir: "/tmp/mira-imagegen-test", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
