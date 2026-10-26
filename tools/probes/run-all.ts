import { parseArgs, redact } from "./shared/env";
import { runP1 } from "./p1/runner";
import { runP2 } from "./p2/probe";
import { runP3 } from "./p3/probe";

const args = parseArgs(process.argv.slice(2));
const mode = args.mock ? "mock" : "real";

console.log(`[all] 顺序执行 P1 → P2 → P3（${mode}）`);
runP1(args)
  .then(async (p1) => ({ p1, p2: await runP2(args) }))
  .then(async ({ p1, p2 }) => ({ p1, p2, p3: await runP3(args) }))
  .then(({ p1, p2, p3 }) => {
    console.log(`[all] 全部完成：P1 ${p1.totalCalls} 次 / P2 ${p2.totalCalls} 次 / P3 ${p3.totalCalls} 次`);
    console.log(`[all] 盲听页：${p3.blindPage}`);
  })
  .catch((error: unknown) => {
    console.error(redact(`[all] 失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`));
    process.exit(1);
  });
