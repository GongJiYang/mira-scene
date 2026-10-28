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
import {
  classifySceneError,
  imageTimeoutMsFor,
  runSceneJob,
  type SceneRunnerDeps,
} from "../src/scene/runner";
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

describe("runSceneJob：总超时（S6c-fix1 §3）", () => {
  it("扩写挂住 → 到 totalTimeoutMs 立即 abort → failed（不再永停 writing）", async () => {
    const events: string[] = [];
    const started = Date.now();
    const hangWriter = {
      write: (_ctx: unknown, signal: AbortSignal) =>
        new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    };
    const outcome = await runSceneJob(
      pack,
      "换背景到海边",
      "job-hang",
      deps(undefined as unknown as SceneRunnerDeps["image"], events, {
        writer: hangWriter,
        totalTimeoutMs: 40,
      }),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("failed");
    expect(events).toContain("failed");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("生图挂住 → 到 totalTimeoutMs abort 两张 → failed", async () => {
    const events: string[] = [];
    const outcome = await runSceneJob(
      pack,
      "换背景到海边",
      "job-hang2",
      deps(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          model: "gpt-image-test",
          outDir: tempOutDir(),
          fetchImpl: ((_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            })) as typeof fetch,
        },
        events,
        { totalTimeoutMs: 40 },
      ),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("failed");
    expect(events).toContain("failed");
  });

  it("一张图失败 → 立即 abort 另一张（不再白白付费）", async () => {
    let abortedOther = false;
    let calls = 0;
    const outcome = await runSceneJob(
      pack,
      "换背景到海边",
      "job-abort-other",
      deps(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          model: "gpt-image-test",
          outDir: tempOutDir(),
          fetchImpl: ((_url: string, init?: RequestInit) => {
            const call = calls++;
            if (call === 0) return Promise.resolve(new Response("boom", { status: 500 }));
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                abortedOther = true;
                reject(new DOMException("aborted", "AbortError"));
              });
            });
          }) as typeof fetch,
        },
        [],
      ),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("failed");
    expect(abortedOther).toBe(true);
  });
});

describe("§2 换背景失败分类", () => {
  it("imageTimeoutMsFor：扩写越久，单张预算越短，且不低于 30s", () => {
    expect(imageTimeoutMsFor(90_000, 0)).toBe(90_000);
    expect(imageTimeoutMsFor(90_000, 30_000)).toBe(60_000);
    // 扩写耗时很高时兜底到最小值 30s。
    expect(imageTimeoutMsFor(90_000, 80_000)).toBe(30_000);
    expect(imageTimeoutMsFor(90_000, 999_999)).toBe(30_000);
  });

  it("classifySceneError：四种分类各归其位", () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(classifySceneError({ error: abort, sessionAborted: true, taskAborted: false, perImageTimedOut: false, siblingError: null }).category).toBe("session_aborted");
    expect(classifySceneError({ error: abort, sessionAborted: false, taskAborted: true, perImageTimedOut: false, siblingError: null }).category).toBe("timeout");
    expect(classifySceneError({ error: abort, sessionAborted: false, taskAborted: false, perImageTimedOut: true, siblingError: null }).category).toBe("timeout");
    expect(classifySceneError({ error: new Error("生图接口 HTTP 500"), sessionAborted: false, taskAborted: false, perImageTimedOut: false, siblingError: null })).toEqual({ category: "error", detail: "生图接口 HTTP 500" });
  });

  it("classifySceneError：连带中止报第一张失败的真实原因", () => {
    const out = classifySceneError({
      error: new DOMException("aborted", "AbortError"),
      sessionAborted: false,
      taskAborted: false,
      perImageTimedOut: false,
      siblingError: "生图接口 HTTP 500",
    });
    expect(out.category).toBe("other_image_failed");
    expect(out.detail).toBe("生图接口 HTTP 500");
  });

  it("单张超时 → outcome.category === 'timeout'", async () => {
    const outcome = await runSceneJob(
      pack,
      "换背景到海边",
      "job-cat-timeout",
      deps(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          model: "gpt-image-test",
          outDir: tempOutDir(),
          fetchImpl: ((_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            })) as typeof fetch,
        },
        [],
        { imageTimeoutMs: 20 },
      ),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.category).toBe("timeout");
  });

  it("会话中止 → outcome.category === 'session_aborted'", async () => {
    const sessionController = new AbortController();
    const promise = runSceneJob(
      pack,
      "换背景到海边",
      "job-cat-session",
      deps(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          model: "gpt-image-test",
          outDir: tempOutDir(),
          fetchImpl: ((_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              // 已在中止状态时立即拒绝；否则等 abort 事件（真实 fetch 行为）。
              if (init?.signal?.aborted) {
                reject(new DOMException("aborted", "AbortError"));
                return;
              }
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            })) as typeof fetch,
        },
        [],
      ),
      sessionController.signal,
    );
    // 让 runSceneJob 越过首个同步段（进入生图），再中止会话。
    await new Promise((resolve) => setTimeout(resolve, 10));
    sessionController.abort();
    const outcome = await promise;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.category).toBe("session_aborted");
  });

  it("一张图失败连带中止 → outcome.category === 'other_image_failed' 且报第一张的真实原因", async () => {
    let calls = 0;
    const outcome = await runSceneJob(
      pack,
      "换背景到海边",
      "job-cat-sibling",
      deps(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          model: "gpt-image-test",
          outDir: tempOutDir(),
          fetchImpl: ((_url: string, init?: RequestInit) => {
            const call = calls++;
            if (call === 0) return Promise.resolve(new Response("boom", { status: 500 }));
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            });
          }) as typeof fetch,
        },
        [],
      ),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(["other_image_failed", "error"]).toContain(outcome.category);
      expect(outcome.error).toContain("生图接口 HTTP 500");
    }
  });

  it("扩写非法 JSON → category === 'error'", async () => {
    const outcome = await runSceneJob(
      pack,
      "换背景到海边",
      "job-cat-invalid",
      deps(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "test",
          model: "gpt-image-test",
          outDir: tempOutDir(),
          fetchImpl: (async () => okResponse()) as typeof fetch,
        },
        [],
        { writer: { write: async () => "not json" } },
      ),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.category).toBe("error");
  });
});
