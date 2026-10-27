/**
 * S6l-fix1 §0：参考图路径解析（区分来源）。
 *
 * S6c-fix1 §7 让参考图 = 当前正在显示的背景。第一次换成生成图后，当前背景 URL 形如
 * `/generated/scene-<id>-desktop.png`，文件实际在生成目录（`var/generated/`，见 imageGen 的
 * `defaultOutDir`），而 `resolveClientAssetPath()` 会把它错误地映射到
 * `apps/client/public/generated/...`（不存在）→ 第二次生图的参考图读取失败。
 *
 * 因此这里按来源分流：`/generated/` 开头的 URL 解析到生成目录，其余仍走客户端静态目录。
 * 纯函数：目录由调用方注入，便于单测。
 */
import { join } from "node:path";

export type ReferenceDirs = {
  /** `/generated/` URL 对应的本地目录（imageGen 的 `defaultOutDir()`）。 */
  generatedDir: string;
  /** 其余公开 URL 对应的客户端静态根（`clientPublicRoot()`）。 */
  clientPublicRoot: string;
};

/** 生成图 URL 的前缀（`generateImage` 返回 `\/generated\/<id>.png`）。 */
const GENERATED_PREFIX = "/generated/";

/**
 * 把当前背景的公开 URL 解析成本地文件路径，作为下一轮生图的参考图。
 * `/generated/` 开头 → 生成目录；其余 → 客户端静态目录。
 */
export function resolveReferencePath(url: string, dirs: ReferenceDirs): string {
  if (url.startsWith(GENERATED_PREFIX)) {
    return join(dirs.generatedDir, url.slice(GENERATED_PREFIX.length));
  }
  return join(dirs.clientPublicRoot, url.replace(/^\/+/, ""));
}
