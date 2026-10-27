import { defineConfig, devices } from "@playwright/test";

/**
 * S4 少量端到端测试（架构关卡 §5）：iPhone 13 视口 + Mock 模式，自动启动 `pnpm dev`。
 * 不做像素级比对，只断言结构与可见性，并把截图存到 `e2e/out/`。
 *
 * 首次运行前需要：`npx playwright install chromium`。
 */
// S6d §3：端口可用环境变量覆盖（并行 worktree 时避免冲突）；默认值保持 8887 / 5273 不变。
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 8887);
const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT ?? 5274);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.artifacts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${CLIENT_PORT}`,
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [
    { name: "iphone-13", use: { ...devices["iPhone 13"], browserName: "chromium" } },
    { name: "desktop", use: { viewport: { width: 1440, height: 900 }, browserName: "chromium" } },
  ],
  webServer: {
    // 强制 Mock：不读取任何 Key，也不发起真实网络请求（Q10）。
    // 用独立端口，避免与开发者本机已在运行的 5173 / 8787 冲突。
    command: `PROVIDER_MODE=mock PORT=${SERVER_PORT} MIRA_CLIENT_PORT=${CLIENT_PORT} MIRA_SERVER_PORT=${SERVER_PORT} pnpm dev`,
    url: `http://localhost:${CLIENT_PORT}`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
