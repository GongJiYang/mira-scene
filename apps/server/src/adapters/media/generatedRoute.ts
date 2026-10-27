/**
 * S6b-fix1 §5：`GET /generated/<file>` 的文件名校验（防路径穿越）。
 * 只允许 `^[a-z0-9_-]+\.png$`，其它一律拒绝（404）。纯函数，便于单测。
 */

const VALID_FILE = /^[a-z0-9_-]+\.png$/;

/** 从请求路径提取合法文件名；非法返回 null（调用方回 404）。 */
export function generatedFileFor(urlPath: string): string | null {
  const prefix = "/generated/";
  if (!urlPath.startsWith(prefix)) return null;
  const file = urlPath.slice(prefix.length);
  // 含任何路径分隔 / 穿越段 / 反斜杠直接拒；正则也已保证只允许安全字符。
  if (file === "" || file.includes("/") || file.includes("\\") || file.includes("..")) return null;
  return VALID_FILE.test(file) ? file : null;
}
