import { redact } from "../shared/env";
import { runP1 } from "./runner";

runP1()
  .then((result) => {
    for (const [id, entry] of Object.entries(result.formats)) {
      console.log(
        `[p1] ${id}: 首句 P50=${entry.summary.latency.p50}ms P90=${entry.summary.latency.p90}ms 解析=${(entry.summary.parseRate * 100).toFixed(1)}% 加权总分=${entry.summary.score.total}`,
      );
    }
  })
  .catch((error: unknown) => {
    console.error(redact(`[p1] 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`));
    process.exitCode = 1;
  });
