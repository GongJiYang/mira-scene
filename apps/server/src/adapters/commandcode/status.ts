/**
 * `cmd status` 输出的纯解析（S6a §2）。实测输出（去掉 ANSI 颜色后）包含：
 *   ✔ Authentication verified
 *   ✔ Authenticated as <用户>
 *   Provider: Command Code
 *
 * 纯函数：`isCommandCodeAuthed(text)` 判断是否已登录。不打印、不记录 Key（status 里本来也没有 Key）。
 */

/** 去掉 ANSI 转义序列（cmd status 带颜色码）。 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** status 输出是否显示「已登录」。 */
export function isCommandCodeAuthed(rawText: string): boolean {
  const text = stripAnsi(rawText);
  if (/not authenticated|unauthenticated|未登录|not logged in/i.test(text)) return false;
  return /Authentication verified|Authenticated as/i.test(text);
}
