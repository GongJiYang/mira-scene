/**
 * S6l-fix1 §0：参考图路径解析单测。
 *
 * 覆盖：生成图 URL → 生成目录；角色包默认背景 URL → 客户端静态目录；手机 / 桌面都能区分。
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveReferencePath } from "../src/scene/referencePath";

const dirs = { generatedDir: "/data/var/generated", clientPublicRoot: "/repo/apps/client/public" };

describe("resolveReferencePath（S6l-fix1 §0）", () => {
  it("/generated/ URL → 生成目录下的同名文件", () => {
    expect(resolveReferencePath("/generated/scene-abc-desktop.png", dirs)).toBe(
      join("/data/var/generated", "scene-abc-desktop.png"),
    );
    expect(resolveReferencePath("/generated/scene-abc-mobile.png", dirs)).toBe(
      join("/data/var/generated", "scene-abc-mobile.png"),
    );
  });

  it("角色包默认背景 URL → 客户端静态目录", () => {
    expect(resolveReferencePath("/characters/yuna/bg-desktop.jpg", dirs)).toBe(
      join("/repo/apps/client/public", "characters", "yuna", "bg-desktop.jpg"),
    );
  });

  it("其它公开 URL（如 /stage/…、/characters/…）也走客户端静态目录", () => {
    expect(resolveReferencePath("/stage/assets/raw/b1_bg_main_h.png", dirs)).toBe(
      join("/repo/apps/client/public", "stage", "assets", "raw", "b1_bg_main_h.png"),
    );
  });
});
