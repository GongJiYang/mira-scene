import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { generatedFileFor } from "../src/adapters/media/generatedRoute";
import { startServer, type ServerHandle } from "../src/index";

/**
 * S6b-fix1 §5：GET /generated/<file> 文件名校验（防路径穿越）+ 集成取文件。
 */
describe("generatedFileFor（S6b-fix1 §5 纯函数）", () => {
  it("合法文件名通过", () => {
    expect(generatedFileFor("/generated/photo_letters.png")).toBe("photo_letters.png");
    expect(generatedFileFor("/generated/a-b_c-1.png")).toBe("a-b_c-1.png");
  });

  it("含路径分隔 / 穿越段 / 反斜杠一律拒绝", () => {
    expect(generatedFileFor("/generated/../etc/passwd")).toBeNull();
    expect(generatedFileFor("/generated/a/b.png")).toBeNull();
    expect(generatedFileFor("/generated/a\\b.png")).toBeNull();
    expect(generatedFileFor("/generated/..%2F..%2Fetc")).toBeNull();
    expect(generatedFileFor("/generated/.hidden.png")).toBeNull();
    expect(generatedFileFor("/generated/Upper.PNG")).toBeNull();
    expect(generatedFileFor("/generated/noext")).toBeNull();
    expect(generatedFileFor("/generated/a.jpg")).toBeNull();
    expect(generatedFileFor("/other/a.png")).toBeNull();
  });

  it("fast-check：任意含 /、..、\\ 的字符串都被拒", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        if (s.includes("/") || s.includes("..") || s.includes("\\")) {
          expect(generatedFileFor(`/generated/${s}`)).toBeNull();
        }
      }),
    );
  });

  it("fast-check：合法字符集生成的文件名都被接受", () => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789_-".split("");
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...chars), { minLength: 1 }).map((arr) => arr.join("")), (name) => {
        expect(generatedFileFor(`/generated/${name}.png`)).toBe(`${name}.png`);
      }),
    );
  });
});

describe("GET /generated/<file>（S6b-fix1 §5 集成）", () => {
  let handle: ServerHandle | null = null;
  let dir = "";

  afterEach(async () => {
    await handle?.close();
    handle = null;
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("生成后 GET 能取到 png；非法文件名 404", async () => {
    dir = mkdtempSync(join(tmpdir(), "mira-generated-"));
    writeFileSync(join(dir, "photo_test.png"), Buffer.from("fake-png"));
    handle = await startServer({ port: 0, env: { PROVIDER_MODE: "mock", GENERATED_DIR: dir } });
    const base = `http://localhost:${handle.port}`;

    const ok = await fetch(`${base}/generated/photo_test.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe("fake-png");

    expect((await fetch(`${base}/generated/missing.png`)).status).toBe(404);
    expect((await fetch(`${base}/generated/../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/generated/a/b.png`)).status).toBe(404);
  });
});
