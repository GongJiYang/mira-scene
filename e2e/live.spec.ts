import { expect, test, type Page } from "@playwright/test";

/**
 * S6b §4 / §6：直播间 UI v1 端到端（Mock 模式）。
 * 桌面 1440×900 与手机 390×844 各跑：发一条弹幕收到回复、切换频道、截图存 e2e/out/live-*.png。
 * 只断言结构与可见性，不做像素级比对。
 */

async function openLive(page: Page): Promise<void> {
  await page.goto("/");
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
}

/** S6b-fix1 §6：等待 Live2D 画布出现非透明像素（最多 20 秒）。 */
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
      // 采样中心一条竖带（人物躯干位置），任一有 alpha 即视为已画出。
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

/** S6b-fix1 §6：等待舞台背景图加载完成（最多 20 秒）。 */
async function waitBackgroundComplete(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const bg = document.querySelector(".live-bg");
      if (!bg) return false;
      const url = getComputedStyle(bg).backgroundImage.match(/url\("?([^"]+)"?\)/)?.[1];
      if (!url) return false;
      return new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
      });
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

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `e2e/out/${name}.png` });
}

test.describe("直播间 UI v1 · S6c 换背景", () => {
  // S6c §6：桌面和手机各发一条「换背景到海边」弹幕 → 出现转场状态 → 新背景出现。
  // Mock 模式：scene_status writing → generating → ready（urls 指向预置测试图）。
  test("发「换背景到海边」弹幕 → 转场状态 → 新背景", async ({ page }, testInfo) => {
    const layout = testInfo.project.name === "desktop" ? "desktop" : "mobile";
    await openLive(page);
    await expect(page.getByTestId("live")).toHaveAttribute("data-layout", layout);

    // 发一条「换背景到海边」弹幕：命中 §1 的 sceneTriggers。
    await submitText(page, "换背景到海边");

    // 转场状态条出现（writing / generating）。
    await expect(page.getByTestId("scene-status")).toBeVisible({ timeout: 10_000 });

    // 新背景出现（ready 后背景 URL 换成测试图）。
    await page.waitForFunction(
      () => {
        const bg = document.querySelector(".live-bg");
        if (!bg) return false;
        const url = getComputedStyle(bg).backgroundImage;
        return url.includes("test-scene");
      },
      undefined,
      { timeout: 15_000, polling: 250 },
    );

    await shot(page, `live-scene-${layout}`);
  });
});

test.describe("直播间 UI v1", () => {
  test("发一条弹幕收到回复", async ({ page }, testInfo) => {
    const layout = testInfo.project.name === "desktop" ? "desktop" : "mobile";
    await openLive(page);
    await expect(page.getByTestId("live")).toHaveAttribute("data-layout", layout);

    // 发一条弹幕：自己的消息进弹幕列表。
    await submitText(page, "你好");
    await expect(page.getByTestId("danmaku-list")).toContainText("你好");

    // 服务端（Mock）回复 → 字幕出现。
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "speaking", { timeout: 20_000 });
    await expect(page.getByTestId("subtitle")).not.toBeEmpty();
    await shot(page, `live-danmaku-${layout}`);
  });

  // S6f §1：夏凛已隐藏，频道栏只剩忧奈；切换频道的用例改为验证「单频道下切换按钮不破坏当前频道」。
  test("单频道下切换按钮不破坏当前频道", async ({ page }, testInfo) => {
    const layout = testInfo.project.name === "desktop" ? "desktop" : "mobile";
    await openLive(page);

    // 默认频道是忧奈（S6f §1）。
    await expect(page.getByTestId("live-name")).toHaveText("忧奈");

    if (layout === "desktop") {
      // 桌面只剩一个频道：点它还是忧奈。
      await page.getByTestId("channel-yuna").click();
    } else {
      // 手机：上下滑动（单频道时仍停在忧奈）。
      const stage = page.getByTestId("live-mobile");
      const box = await stage.boundingBox();
      if (!box) throw new Error("live-mobile 不可见");
      const x = box.x + box.width / 2;
      const startY = box.y + box.height * 0.7;
      await page.touchscreen.tap(x, startY); // 保证触摸上下文
      await page.evaluate(
        ({ sx, sy, dy }) => {
          const target = document.querySelector('[data-testid="live-mobile"]');
          if (!target) return;
          const make = (type: string, y: number) =>
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: type === "touchend" ? [] : [new Touch({ identifier: 1, target, clientX: sx, clientY: y })],
              changedTouches: [new Touch({ identifier: 1, target, clientX: sx, clientY: y })],
            });
          target.dispatchEvent(make("touchstart", sy));
          target.dispatchEvent(make("touchend", sy + dy));
        },
        { sx: x, sy: startY, dy: -160 },
      );
    }

    await expect(page.getByTestId("live-name")).toHaveText("忧奈", { timeout: 20_000 });

    // S6b-fix1 §6：等 Live2D 画布真的画出非透明像素 + 背景图加载完成，再截图。
    await waitLive2DPainted(page);
    await waitBackgroundComplete(page);
    await shot(page, `live-switch-${layout}`);
  });

  // S6f §1：夏凛已隐藏；改为验证默认频道（忧奈）的舞台已渲染。
  test("默认频道（忧奈）舞台已渲染", async ({ page }, testInfo) => {
    const layout = testInfo.project.name === "desktop" ? "desktop" : "mobile";
    await openLive(page);
    await expect(page.getByTestId("live-name")).toHaveText("忧奈");
    await waitLive2DPainted(page);
    await waitBackgroundComplete(page);
    await shot(page, `live-default-${layout}`);
  });
});
