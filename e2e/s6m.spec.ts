import { expect, test, type Page } from "@playwright/test";

/**
 * S6m §4 / freeze-fix1 §7：动作表 —— 打开 → 点挥手 → 截图（本批运行）。
 *
 * - 桌面：点弹幕窗口顶部的「动作表」标签展开面板；
 * - 手机：**从右上角菜单打开**（动作表在菜单抽屉里）→ 底部抽屉；
 * - 点「挥手」→ 只在本地预览（不发网络、不算一轮），`data-phase` 仍是 idle → 截图。
 */

async function openLive(page: Page): Promise<void> {
  await page.goto("/");
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
}

const layoutOf = (testInfo: { project: { name: string } }): "desktop" | "mobile" =>
  testInfo.project.name === "desktop" ? "desktop" : "mobile";

test.describe("S6m §3 动作表", () => {
  test("打开动作表 → 点挥手 → 仍是 idle → 截图", async ({ page }, testInfo) => {
    await openLive(page);
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle", { timeout: 30_000 });

    if (layoutOf(testInfo) === "desktop") {
      // 桌面：展开弹幕窗口顶部的「动作表」。
      await page.getByTestId("action-toggle").click();
    } else {
      // 手机：打开右上角菜单 → 动作表（菜单抽屉里的入口）→ 底部抽屉。
      await page.getByTestId("mobile-menu-toggle").click();
      await expect(page.getByTestId("mobile-menu-panel")).toBeVisible();
      await page.getByTestId("action-toggle").click();
    }

    const panel = page.getByTestId("action-panel");
    await expect(panel).toBeVisible();

    // 点「挥手」→ 只在本地预览。
    await page.getByTestId("action-wave").click();
    // 预览不发网络、不算一轮：phase 仍为 idle。
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle");

    await page.screenshot({ path: "e2e/out/s6m-action-panel.png" });
  });
});
