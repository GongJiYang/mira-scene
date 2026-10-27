import { expect, test, type Page } from "@playwright/test";

/**
 * S6f §3：隐藏夏凛 + 忧奈四态动作。
 * - 频道栏只看得到一个频道（忧奈）；
 * - 四个状态（idle / listening / thinking / speaking）各截一张图存 e2e/out/s6f-<phase>.png；
 * - 断言 Live2D 画布非空。
 */

async function openLive(page: Page): Promise<void> {
  await page.goto("/");
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
}

/** 等待 Live2D 画布出现非透明像素（最多 20 秒）。 */
async function waitLive2DPainted(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('[data-testid="yuna-canvas"]') as HTMLCanvasElement | null;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
      const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGL2RenderingContext | WebGLRenderingContext | null;
      if (!gl) return false;
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      if (w === 0 || h === 0) return false;
      const strip = new Uint8Array(4 * Math.min(w, 64) * h);
      gl.readPixels(Math.floor(w / 2) - Math.min(w, 32), 0, Math.min(w, 64), h, gl.RGBA, gl.UNSIGNED_BYTE, strip);
      for (let i = 3; i < strip.length; i += 4) {
        if (strip[i] !== 0) return true;
      }
      return false;
    },
    undefined,
    { timeout: 20_000, polling: 250 },
  );
}

async function submitText(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("text-input");
  await input.fill(text);
  await input.press("Enter");
}

test.describe("S6f：隐藏夏凛 + 忧奈四态", () => {
  test("频道栏只剩忧奈一个", async ({ page }, testInfo) => {
    const layout = testInfo.project.name === "desktop" ? "desktop" : "mobile";
    await openLive(page);
    await expect(page.getByTestId("live-name")).toHaveText("忧奈");
    if (layout === "desktop") {
      await expect(page.getByTestId("channel-yuna")).toBeVisible();
    }
    // 隐藏角色在任何布局下都不应出现在频道栏。
    await expect(page.getByTestId("channel-rin")).toHaveCount(0);
  });

  test("四态截图（idle / listening / thinking / speaking）且画布非空", async ({ page }, testInfo) => {
    const layout = testInfo.project.name === "desktop" ? "desktop" : "mobile";
    await openLive(page);
    await waitLive2DPainted(page);

    // idle
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle");
    await page.screenshot({ path: `e2e/out/s6f-idle.png` });

    // listening：按住 PTT（桌面空格 / 手机点按）。用 PTT 按钮。
    await page.getByTestId("ptt").dispatchEvent("pointerdown");
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "listening");
    await page.screenshot({ path: `e2e/out/s6f-listening.png` });
    await page.getByTestId("ptt").dispatchEvent("pointerup");

    // thinking + speaking：发一条文字，等 thinking 出现截图，再等 speaking 出现截图。
    await submitText(page, "你好");
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "thinking", { timeout: 20_000 });
    await page.screenshot({ path: `e2e/out/s6f-thinking.png` });
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "speaking", { timeout: 20_000 });
    await page.screenshot({ path: `e2e/out/s6f-speaking.png` });

    // 布局变量占位（避免 lint 未使用告警；布局不同截图内容不同）。
    expect(layout).toBeTruthy();
  });
});
