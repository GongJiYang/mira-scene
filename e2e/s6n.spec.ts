import { expect, test, type Page } from "@playwright/test";

/**
 * S6n §4/§5：设置面板 —— 打开 → 切 Mock → 顶栏标签变 Mock。**只写不跑**（铁律：不运行 e2e）。
 *
 * - 桌面：点顶栏「设置」→ 对话框；点「Mock」→「保存并重新连接」→ 顶栏标签变「Mock」。
 * - 手机：打开右上角菜单 → 「设置」→ 底部抽屉；同上。
 */

async function openLive(page: Page): Promise<void> {
  await page.goto("/");
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
}

const layoutOf = (testInfo: { project: { name: string } }): "desktop" | "mobile" =>
  testInfo.project.name === "desktop" ? "desktop" : "mobile";

test.describe("S6n §5 设置面板", () => {
  test("打开设置 → 切 Mock → 保存 → 顶栏标签变 Mock", async ({ page }, testInfo) => {
    await openLive(page);
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle", { timeout: 30_000 });

    if (layoutOf(testInfo) === "desktop") {
      await page.getByTestId("settings-toggle").click();
    } else {
      await page.getByTestId("mobile-menu-toggle").click();
      await page.getByTestId("settings-toggle").click();
    }

    const dialog = page.getByTestId("settings-dialog");
    await expect(dialog).toBeVisible();

    // 三选一：点「Mock」。
    await page.getByTestId("settings-mode-mock").click();
    // 保存并重新连接（新会话）。
    await page.getByTestId("settings-save").click();

    // 顶栏标签变 Mock。
    await expect(page.getByTestId("mode-badge")).toHaveAttribute("data-mode", "mock", { timeout: 20_000 });
    await expect(page.getByTestId("mode-badge")).toHaveText("Mock");

    await page.screenshot({ path: "e2e/out/s6n-settings-mock.png" });
  });
});
