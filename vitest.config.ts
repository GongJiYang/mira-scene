import { configDefaults, defineConfig } from "vitest/config";

/**
 * 单元/集成测试用 Vitest；端到端测试归 Playwright（`pnpm e2e`），
 * 因此把 `e2e/` 从 Vitest 的收集范围里排除，避免两套 test() 互相干扰。
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
