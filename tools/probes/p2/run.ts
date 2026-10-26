import { redact } from "../shared/env";
import { runP2 } from "./probe";

runP2()
  .then(() => undefined)
  .catch((error: unknown) => {
    console.error(redact(`[p2] 失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`));
    process.exit(1);
  });
