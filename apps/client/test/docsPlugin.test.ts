import { describe, expect, it } from "vitest";
import fc from "fast-check";
import path from "node:path";
import {
  decodeDocPath,
  encodeDocPath,
  filterCandidates,
  resolveWithinRoot,
} from "../vite/docsPlugin";

const ROOT = "/repo/root";

describe("encodeDocPath / decodeDocPath", () => {
  it("往返一致（round-trip）", () => {
    const cases = [
      "docs/architecture/decisions.md",
      "docs/tasks/s6d-docs-report.md",
      "characters/yuna/prompt.v1.md",
      "README.md",
      "docs/ai-usage-log.md",
    ];
    for (const repoPath of cases) {
      expect(decodeDocPath(encodeDocPath(repoPath))).toBe(repoPath);
    }
  });

  it("特殊字符（空格、中文、#、%）能正确往返", () => {
    const cases = ["docs/my dir/文件 #1.md", "docs/a%20b/c.md", "docs/100%/x.md"];
    for (const repoPath of cases) {
      expect(decodeDocPath(encodeDocPath(repoPath))).toBe(repoPath);
    }
  });

  it("拒绝 .. 与 . 段", () => {
    expect(decodeDocPath("..")).toBeNull();
    expect(decodeDocPath("docs/../../etc/passwd")).toBeNull();
    expect(decodeDocPath("docs/./x.md")).toBeNull();
    // 编码形式的 .. 同样拒绝。
    expect(decodeDocPath("docs/%2e%2e/x.md")).toBeNull();
    expect(decodeDocPath("docs/%2E%2E/%2e%2e/passwd")).toBeNull();
  });

  it("拒绝绝对路径、盘符与反斜杠", () => {
    expect(decodeDocPath("%2Fetc%2Fpasswd")).toBeNull();
    expect(decodeDocPath(encodeURIComponent("/etc/passwd"))).toBeNull();
    expect(decodeDocPath("C:%5CWindows%5Csystem32")).toBeNull();
    expect(decodeDocPath("docs%5C..%5Csecret.md")).toBeNull();
  });

  it("拒绝空段、隐藏段与非法编码", () => {
    expect(decodeDocPath("")).toBeNull();
    expect(decodeDocPath("docs//x.md")).toBeNull();
    expect(decodeDocPath(".env")).toBeNull();
    expect(decodeDocPath("docs/.secret/x.md")).toBeNull();
    expect(decodeDocPath("%zz")).toBeNull();
  });

  it("属性：任意字符串解码后都不是绝对路径、不含 ..（fast-check）", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (input) => {
        const decoded = decodeDocPath(input);
        if (decoded === null) return;
        expect(path.posix.isAbsolute(decoded)).toBe(false);
        expect(path.win32.isAbsolute(decoded)).toBe(false);
        expect(decoded.split("/")).not.toContain("..");
        expect(decoded.includes("\\")).toBe(false);
        expect(decoded.includes("\0")).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("属性：任意字符串经「解码 + 解析」后不会落到仓库外（fast-check）", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (input) => {
        const decoded = decodeDocPath(input);
        if (decoded === null) return;
        const absolute = resolveWithinRoot(ROOT, decoded);
        if (absolute === null) return;
        const relative = path.relative(ROOT, absolute);
        expect(relative.startsWith("..")).toBe(false);
        expect(path.isAbsolute(relative)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});

describe("resolveWithinRoot", () => {
  it("正常路径解析到仓库内", () => {
    expect(resolveWithinRoot(ROOT, "docs/architecture/decisions.md")).toBe(
      path.join(ROOT, "docs/architecture/decisions.md"),
    );
  });

  it("拒绝逃逸到仓库外", () => {
    expect(resolveWithinRoot(ROOT, "../outside.md")).toBeNull();
    expect(resolveWithinRoot(ROOT, "docs/../../outside.md")).toBeNull();
    expect(resolveWithinRoot(ROOT, "")).toBeNull();
  });
});

describe("filterCandidates", () => {
  it("用 isIncluded 过滤并排序", () => {
    const filtered = filterCandidates([
      "docs/tasks/s6d-docs.md", // 任务说明：不收录
      "docs/tasks/s6d-docs-report.md",
      "docs/tasks/.s6d-cmd.log",
      "docs/architecture/roadmap.md",
      "docs/architecture/decisions.md",
      "characters/yuna/scene.v1.md",
      "characters/yuna/content.json",
      "README.md",
      "apps/client/src/App.tsx",
    ]);
    expect(filtered).toEqual([
      "characters/yuna/scene.v1.md",
      "docs/architecture/decisions.md",
      "docs/architecture/roadmap.md",
      "docs/tasks/s6d-docs-report.md",
      "README.md",
    ]);
  });

  it("属性：任意路径列表输出都是白名单成员（fast-check）", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 40 }), { maxLength: 8 }), (candidates) => {
        for (const kept of filterCandidates(candidates)) {
          // 过滤结果必须命中白名单：不含 .log、隐藏段、任务说明。
          expect(kept.endsWith(".log")).toBe(false);
          expect(kept.split("/").every((seg) => !seg.startsWith("."))).toBe(true);
          expect(/^docs\/tasks\/(?!.*-report\.md$)/.test(kept)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });
});
