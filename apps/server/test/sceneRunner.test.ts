/**
 * S6c §6：换背景执行器（runSceneJob）在「真实」生图路径下的一致性测试。
 *
 * 覆盖集成清单里需要假 fetch 的两条：
 * - 生图超时（单张超时）；
 * - 只成一张图（另一张失败 → 整体 failed，保持原背景）。
 *
 * 不走网络：注入假 fetch；参考图指向仓库里真实存在的测试图。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSceneJob, type SceneRunnerDeps } from "../src/scene/runner";
import { createMockSceneWriter } from "../src/adapters/mock/mockSceneWriter";
import { clientPublicRoot } from "../src/characters/pack";
import { testPack } from "./helpers/pack";

const pack = testPack("yuna");

/** 一张真实的参考图（绝对路径：imageGen 里按 cwd 解析，测试用绝对路径最稳）。 */
const REFERENCE = join(clientPublicRoot(), "characters", "yuna", "bg-desktop.jpg");

let outDirs: string[] = [];
afterEach(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
  outDirs = [];
});

function tempOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scene-runner-"));
  outDirs.push(dir);
  return dir;
}

/** 一张成功的生图响应（1×1 PNG 的 base64）。 */
const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC";

function okResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: ONE_PX_PNG }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deps(image: SceneRunnerDeps["image"], events: string[], overrides: Partial<SceneRunnerDeps> = {}): SceneRunnerDeps {
  return {
    writer: createMockSceneWriter(),
    image,
    referencePaths: { desktop: REFERENCE, mobile: REFERENCE },
    nodeLabel: "下播之后",
    currentScene: "bedroom",
    emit: (_event, payload) => void events.push(payload.status),
    now: () => 0,
    ...overrides,
  };
}

describe("runSceneJob：真实生图路径（S6c §4 / §6）", () => {
  it("两张都成功 → ready，scene_status 序列 writing → generating → ready", async () => {
    const events: string[] = [];
    const outcome = await runSceneJob(
      pack,
      "换背景到海边",
      "job-1",
      deps(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          model: "gpt-image-test",
          outDir: tempOutDir(),
          fetchImpl: (async () => okResponse()) as typeof fetch,
        },
        events,
      ),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("ready");
    expect(events).toEqual(["writing", "generating", "ready"]);
    if (outcome.kind === "ready") {
      expect(outcome.urls.desktop).toMatch(/^\/generated\/scene-job-1-desktop\.png$/);
      expect(outcome.urls.mobile).toMatch(/^\/generated\/scene-job-1-mobile\.png$/);
    }
  });

  it("只成一张图（另一张 HTTP 错误）→ failed，且不应 ready", async () => {
    const events: string[] = [];
    let calls = 0;
    const outcome = await runSceneJob(
      pack,
      "换背景到海边",
      "job-2",
      deps(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          model: "gpt-image-test",
          outDir: tempOutDir(),
          // 第一张成功、第二张失败（两次调用按顺序返回）。
          fetchImpl: (async () => {
            const call = calls++;
            return call === 0 ? okResponse() : new Response("boom", { status: 500 });
          }) as typeof fetch,
        },
        events,
      ),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("failed");
    expect(events).toContain("failed");
    expect(events).not.toContain("ready");
  });

  it("生图超时（单张超时）→ failed", async () => {
    const events: string[] = [];
    const outcome = await runSceneJob(
      pack,
      "换背景到海边",
      "job-3",
      deps(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          model: "gpt-image-test",
          outDir: tempOutDir(),
          // 永不 resolve：让单张 20ms 超时触发。
          fetchImpl: ((_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            })) as typeof fetch,
        },
        events,
        { imageTimeoutMs: 20 },
      ),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("failed");
    expect(events).toContain("failed");
  });
});
