import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, writeText } from "../shared/io";
import { redact } from "../shared/env";
import { renderBlindPage } from "./blind";
import type { P3Result } from "./probe";

/** 只重建盲听页，不发任何网络请求（用最近一次 P3 结果）。 */
const files = readdirSync(OUT_DIR)
  .filter((name) => name.startsWith("p3-") && name.endsWith(".json"))
  .sort();
const latest = files.at(-1);
if (latest === undefined) {
  console.error("[p3] 没有找到 out/p3-*.json，先跑 pnpm probe:p3");
  process.exit(1);
}
const result = JSON.parse(readFileSync(join(OUT_DIR, latest), "utf8")) as P3Result;
const blindPath = join(OUT_DIR, "p3", "blind.html");
writeText(blindPath, renderBlindPage(result.entries, Date.now() % 100_000));
console.log(redact(`[p3] 已用 ${latest} 重建盲听页：${blindPath}`));
