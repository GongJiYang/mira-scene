/**
 * freeze-fix8 §1：字体自托管约束（先写会失败的测试）。
 *
 * 国内网络访问不了 Google Fonts，`index.html` 的 preconnect + stylesheet 会阻塞渲染，
 * 手机端白屏。这里断言：应用源码（index.html + 所有 css）不再引用 Google Fonts；
 * 并且自托管的 VT323 字体文件与 @font-face 声明齐全。
 */
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const clientDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(clientDir, "..", "..");

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

describe("freeze-fix8 §1 应用源码不引用 Google Fonts", () => {
  it("index.html 不含 fonts.googleapis / fonts.gstatic", () => {
    const html = readText(join(clientDir, "index.html"));
    expect(html).not.toContain("fonts.googleapis");
    expect(html).not.toContain("fonts.gstatic");
  });

  it("所有 css 不含 fonts.googleapis / fonts.gstatic", () => {
    const files = globSync(["**/*.css"], {
      cwd: repoRoot,
      exclude: (name) => name.includes("node_modules") || name.includes("/dist/") || name.includes("/.git/"),
    });
    expect(files.length, "应扫到至少一个 css 文件").toBeGreaterThan(0);
    const offenders = files.filter((rel) => {
      const text = readText(join(repoRoot, rel));
      return text.includes("fonts.googleapis") || text.includes("fonts.gstatic");
    });
    expect(offenders.map((rel) => relative(repoRoot, rel))).toEqual([]);
  });

  it("VT323 自托管：字体文件存在且 css 用 @font-face 引入", () => {
    const fontPath = join(clientDir, "public", "fonts", "vt323-latin-400-normal.woff2");
    expect(() => readFileSync(fontPath)).not.toThrow();

    const files = globSync(["apps/client/src/**/*.css"], { cwd: repoRoot });
    const withFace = files.filter((rel) => {
      const text = readText(join(repoRoot, rel));
      return text.includes("@font-face") && text.includes("VT323");
    });
    expect(withFace.length, "应有 css 用 @font-face 声明 VT323").toBeGreaterThan(0);
  });
});
