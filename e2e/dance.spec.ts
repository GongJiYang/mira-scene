import { expect, test } from "@playwright/test";

// 动作表「跳舞」：Live2D 无缝切到 AI 舞蹈视频，点「停止」切回。
test.describe("动作表 · 跳舞", () => {
  test("跳舞 → 视频盖住 Live2D；停止 → 切回 Live2D", async ({ page }, testInfo) => {
    await page.goto("/");
    await expect(page.getByTestId("yuna-canvas")).toBeVisible({ timeout: 30_000 });
    if (testInfo.project.name === "iphone-13") {
      await page.getByTestId("mobile-menu-toggle").click();
    }
    await page.getByTestId("action-toggle").click();
    const dance = page.getByTestId("action-dance");
    await expect(dance).toBeEnabled({ timeout: 30_000 });
    await dance.click();

    const video = page.getByTestId("dance-video");
    await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).style.opacity), { timeout: 20_000 }).toBe("1");
    await expect.poll(() => page.getByTestId("yuna-canvas").evaluate((el) => (el as HTMLCanvasElement).style.opacity)).toBe("0");
    // 视频位置在画布范围内（配准后与人物重合）
    const [v, c] = await Promise.all([video.boundingBox(), page.getByTestId("yuna-canvas").boundingBox()]);
    expect(v && c && v.x > c.x && v.x + v.width < c.x + c.width).toBeTruthy();

    await dance.click(); // 停止
    await expect.poll(() => page.getByTestId("yuna-canvas").evaluate((el) => (el as HTMLCanvasElement).style.opacity), { timeout: 5_000 }).toBe("1");
    await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).style.opacity)).toBe("0");
  });
});
