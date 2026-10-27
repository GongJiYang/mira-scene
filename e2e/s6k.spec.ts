import { expect, test, type Page } from "@playwright/test";

/**
 * S6k §6：语境表情 accent 的端到端（Mock 模式）。
 *
 * Mock 剧本（见 content.json + mockLlm.ts）：arrive 节点 look.accent = amazed，
 * 放在该轮第一句；第 1 轮就能看到 accent 生效。截图 `s6k-accent.png`（手机 `-mobile`），
 * 必须在 ending 视频出现之前截。
 *
 * 断言：live 根节点的 data-accent 在第 1 轮 speaking 时变为 amazed，之后回空。
 */

async function openLive(page: Page): Promise<void> {
  await page.goto("/");
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
}

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

test.describe("S6k：语境表情 accent", () => {
  test("arrive 第一句带 accent=amazed，截一张带 accent 的图（ending 视频之前）", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const layout = testInfo.project.name === "desktop" ? "desktop" : "mobile";
    await openLive(page);
    await waitLive2DPainted(page);

    // 第 1 轮：arrive 节点第一句 accent=amazed（Mock content.json）。
    await submitText(page, "你好");
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "speaking", { timeout: 20_000 });
    await expect(page.getByTestId("live")).toHaveAttribute("data-accent", "amazed", { timeout: 20_000 });

    // ending 视频（hearts / story-video）此时绝不该出现。
    await expect(page.getByTestId("story-video-wrap")).toHaveCount(0);

    await page.screenshot({ path: `e2e/out/s6k-accent${layout === "mobile" ? "-mobile" : ""}.png` });

    // 这一轮结束（回 idle）后 accent 清空。
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle", { timeout: 30_000 });
    await expect(page.getByTestId("live")).toHaveAttribute("data-accent", "");
  });
});
