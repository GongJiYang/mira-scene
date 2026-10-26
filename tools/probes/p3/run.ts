import { redact } from "../shared/env";
import { runP3 } from "./probe";

runP3()
  .then((result) => {
    for (const [model, summary] of Object.entries(result.summary)) {
      console.log(
        `[p3] ${model}: 首字节 P50=${summary.ttfbP50}ms P90=${summary.ttfbP90}ms 成功 ${summary.ok}/${summary.calls}`,
      );
    }
  })
  .catch((error: unknown) => {
    console.error(redact(`[p3] 失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`));
    process.exit(1);
  });
