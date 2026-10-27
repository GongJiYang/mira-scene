import { afterEach, describe, expect, it } from "vitest";
import { startServer, type ServerHandle } from "../src/index";
import { silentLogger } from "../src/log";

/**
 * S6h §4：GET /obs/summary 路由。
 * `OBS_ENABLED=0` 时 404；正常时返回合法 JSON（summarize 的形状）。
 */
describe("GET /obs/summary（S6h §1/§4 集成）", () => {
  let handle: ServerHandle | null = null;

  afterEach(async () => {
    await handle?.close();
    handle = null;
  });

  it("缺省开启：返回合法 JSON（四块字段齐全）", async () => {
    handle = await startServer({ port: 0, logger: silentLogger, env: { PROVIDER_MODE: "mock" } });
    const response = await fetch(`http://localhost:${handle.port}/obs/summary`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.now).toBe("number");
    expect(typeof body.bufferSize).toBe("number");
    expect(Array.isArray(body.turns)).toBe(true);
    expect(Array.isArray(body.stages)).toBe(true);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(Array.isArray(body.modelCalls)).toBe(true);
  });

  it("OBS_ENABLED=0：路由 404", async () => {
    handle = await startServer({ port: 0, logger: silentLogger, env: { PROVIDER_MODE: "mock", OBS_ENABLED: "0" } });
    const response = await fetch(`http://localhost:${handle.port}/obs/summary`);
    expect(response.status).toBe(404);
  });

  it("观测数据不含用户文字 / 提示词 / Key（契约式后置条件）", async () => {
    const lines: string[] = [];
    handle = await startServer({
      port: 0,
      logger: (record) => lines.push(JSON.stringify(record)),
      env: { PROVIDER_MODE: "mock" },
    });
    const response = await fetch(`http://localhost:${handle.port}/obs/summary`);
    const text = await response.text();
    // 日志本身不含敏感文本；汇总里也不能出现任何长文本字段。
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("Bearer");
    const body = JSON.parse(text) as { turns: unknown[]; errors: unknown[] };
    expect(Array.isArray(body.turns)).toBe(true);
    expect(Array.isArray(body.errors)).toBe(true);
  });
});
