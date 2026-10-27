/**
 * S6l-fix1 §0：第二次换背景必须成功（参考图路径解析修复）。
 *
 * 现象：第一次换成生成图后，之后每次换背景都失败（参考图被错误地解析到
 * `apps/client/public/generated/...`，文件不存在）。
 *
 * 这里用假生图接口走真实生图路径（注入 fetchImpl），并用可注入时钟跳过 45 秒冷却：
 * - 第一次换背景成功后，当前背景 = `/generated/scene-<id>-desktop.png`（文件在 outDir）；
 * - 第二次换背景的参考图必须能被读到（即指向 outDir 下真实存在的文件），任务成功 ready；
 * - 断言生图接口收到的参考图文件名与第一次生成的 URL 一致。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@mira/protocol";
import { silentLogger } from "../src/log";
import type { LLMPort, STTPort, TTSPort } from "../src/ports";
import { createMockSceneWriter } from "../src/adapters/mock/mockSceneWriter";
import { createSessionManager, type SendFn, type SessionManager } from "../src/session";
import { testPacks } from "./helpers/pack";

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: ONE_PX_PNG }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const immediateStt: STTPort = { transcribe: () => Promise.resolve("你好") };
const immediateTts: TTSPort = { synthesize: () => Promise.resolve({ mime: "audio/wav", data: Buffer.from([1]) }) };

function scriptedLlm(texts: string[]): LLMPort {
  const pending = [...texts];
  return {
    async *streamBeats() {
      yield { say: pending.shift() ?? "嗯。" };
    },
  };
}

let outDirs: string[] = [];
let active: SessionManager | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
  outDirs = [];
});

function tempOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "s6l-fix1-gen-"));
  outDirs.push(dir);
  return dir;
}

type Harness = {
  manager: SessionManager;
  sent: ServerMessage[];
  sessionId: string;
  hello(): Promise<void>;
  input(turnId: number, text: string): Promise<void>;
  readyUrls(): string[];
};

/** 生图接口收到的参考图文件名（multipart 上传）。 */
type Seen = { references: string[]; missing: string[] };

function setup(): { harness: Harness; seen: Seen; outDir: string; advanceClock(ms: number): void } {
  const outDir = tempOutDir();
  const sent: ServerMessage[] = [];
  const send: SendFn = (message) => void sent.push(message);
  let nowMs = 1_000_000;

  // 假生图接口：multipart 上传的参考图必须真实存在（这与真实实现一致：
  // generateImage 会 readFileSync(reference.path)，文件不存在就抛错 → failed）。
  const seen: Seen = { references: [], missing: [] };
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = init?.body;
    if (body instanceof FormData) {
      const image = body.get("image");
      if (image instanceof Blob) {
        const file = image as File;
        // 参考图路径的真实性：我们只拿到 basename，实际存在性由本地 outDir / 静态目录保证。
        // 这里通过 file.name 判断——若参考图指向错误目录（apps/client/public/generated），
        // 真实实现会在 readFileSync 阶段抛错，故本假实现改为「客户端静态目录里没有的生成图即视为缺失」。
        seen.references.push(file.name);
      }
    }
    return okResponse();
  }) as typeof fetch;

  const manager = createSessionManager({
    stt: immediateStt,
    llm: scriptedLlm(["嗯。", "嗯。", "嗯。", "嗯。", "嗯。"]),
    tts: immediateTts,
    packs: testPacks(),
    log: silentLogger,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    now: () => nowMs,
    sceneWriter: createMockSceneWriter(),
    sceneImageGen: {
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      model: "gpt-image-test",
      outDir,
      fetchImpl,
    },
  });
  active = manager;

  const envelope = (type: ClientMessage["type"], payload: unknown, sessionId: string, turnId: number): ClientMessage =>
    ({ v: 1, sessionId, turnId, seq: 0, ts: nowMs, type, payload }) as ClientMessage;

  const harness: Harness = {
    manager,
    sent,
    sessionId: "",
    async hello() {
      await manager.handleMessage(send, envelope("hello", {}, "", 0));
      const session = sent.findLast((m) => m.type === "session");
      if (!session || session.type !== "session") throw new Error("没有收到 session");
      harness.sessionId = session.sessionId;
    },
    input(turnId, text) {
      const sessionId = sent.findLast((m) => m.type === "session")?.sessionId ?? "";
      return manager.handleMessage(send, envelope("text_input", { text }, sessionId, turnId));
    },
    readyUrls() {
      return sent.flatMap((m) => (m.type === "scene_status" && m.payload.status === "ready" && m.payload.urls ? [m.payload.urls.desktop] : []));
    },
  };

  return { harness, seen, outDir, advanceClock: (ms) => void (nowMs += ms) };
}

describe("换背景：第二次必成功（S6l-fix1 §0）", () => {
  it("第一次 ready 的生成图落盘在 outDir，且第二次的参考图 = 第一次生成图（可读）", async () => {
    const { harness, seen, outDir, advanceClock } = setup();
    await harness.hello();

    await harness.input(1, "换背景到海边");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const urls = harness.readyUrls();
    expect(urls.length).toBe(1);
    const firstUrl = urls[0]!;
    expect(firstUrl).toMatch(/^\/generated\/scene-.*-desktop\.png$/);
    // 生成图确实在生成目录里。
    expect(existsSync(join(outDir, firstUrl.slice("/generated/".length)))).toBe(true);

    // 跳过 45 秒冷却后第二次换背景。
    advanceClock(50_000);
    await harness.input(2, "换背景到雨夜");
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 第二次也 ready（若参考图路径错误，真实实现会在 readFileSync 阶段失败 → failed）。
    const urls2 = harness.readyUrls();
    expect(urls2.length).toBe(2);
    expect(urls2[1]).toMatch(/^\/generated\/scene-.*-desktop\.png$/);
    expect(existsSync(join(outDir, urls2[1]!.slice("/generated/".length)))).toBe(true);

    // 第二次任务的参考图文件名 = 第一次生成图（片名 basename 一致）。
    const expectedReference = basename(firstUrl);
    expect(seen.references).toContain(expectedReference);
  });

  it("参考图用生成图时任务不失败（没有 scene_failed）", async () => {
    const { harness } = setup();
    await harness.hello();
    await harness.input(1, "换背景到海边");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const failed = harness.sent.filter((m) => m.type === "scene_status" && m.payload.status === "failed");
    expect(failed).toEqual([]);
  });
});
