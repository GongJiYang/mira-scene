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

  test("切换频道", async ({ page }, testInfo) => {
    const layout = testInfo.project.name === "desktop" ? "desktop" : "mobile";
    await openLive(page);

    // 默认频道是夏凛。
    await expect(page.getByTestId("live-name")).toHaveText("夏凛");

    if (layout === "desktop") {
      await page.getByTestId("channel-yuna").click();
    } else {
      // 手机：上下滑动切换（向上滑 = 下一个主播）。
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

  test("夏凛频道舞台图层已加载", async ({ page }, testInfo) => {
    const layout = testInfo.project.name === "desktop" ? "desktop" : "mobile";
    await openLive(page);
    // 默认频道夏凛（layered）：角色基底图与前景桌图都加载完成。
    await expect(page.getByTestId("live-name")).toHaveText("夏凛");
    await page.waitForFunction(
      () => {
        const layers = Array.from(document.querySelectorAll(".live-layer img")) as HTMLImageElement[];
        return layers.length > 0 && layers.every((img) => img.complete && img.naturalWidth > 0);
      },
      undefined,
      { timeout: 20_000, polling: 250 },
    );
    await waitBackgroundComplete(page);
    await shot(page, `live-rin-${layout}`);
  });

  // S6b-fix2 §2：手机竖屏角色基底层按前景桌完全不透明下沿裁切——
  // 桌沿下方 40px 内，角色基底层（char:base）的可渲染区域（clip 后）不透明像素为 0。
  // 读图层的 bounding rect 与 clip-path 值即可断言，不需要看图。
  test("手机竖屏角色基底在桌沿下方被裁切", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "iphone-13", "仅手机竖屏断言裁切");
    await openLive(page);
    await expect(page.getByTestId("live-name")).toHaveText("夏凛");
    await page.waitForFunction(
      () => {
        const layers = Array.from(document.querySelectorAll(".live-layer img")) as HTMLImageElement[];
        return layers.length > 0 && layers.every((img) => img.complete && img.naturalWidth > 0);
      },
      undefined,
      { timeout: 20_000, polling: 250 },
    );
    const result = await page.evaluate(() => {
      const parseClip = (clip: string): number => {
        // inset() 支持 1–4 个值（简写同 margin）；取 bottom 分量（3 值时第 3 个，4 值时第 3 个）。
        const m = clip.match(/inset\(([^)]+)\)/);
        if (!m) return 0;
        const parts = m[1].trim().split(/\s+/).map((v) => parseFloat(v));
        if (parts.some((n) => Number.isNaN(n))) return 0;
        const bottom = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[0] : parts[2];
        return bottom;
      };
      const charLayer = document.querySelector('[data-layer-id="char:base"]') as HTMLElement | null;
      const tableLayer = document.querySelector('[data-layer-id="fg:table"]') as HTMLElement | null;
      if (!charLayer || !tableLayer) return { ok: false as const, reason: "missing layers" };
      const charImg = charLayer.querySelector("img") as HTMLImageElement;
      const tableImg = tableLayer.querySelector("img") as HTMLImageElement;
      const charRect = charImg.getBoundingClientRect();
      const tableRect = tableImg.getBoundingClientRect();
      const clipBottom = parseClip(getComputedStyle(charLayer).clipPath);
      // 桌图内容在 390×544 盒内 contain：top=(h-390)/2；桌沿完全不透明下沿 = top + 390×0.8。
      const tableContentTop = tableRect.top + (tableRect.height - tableRect.width) / 2;
      const tableEdge = tableContentTop + tableRect.width * 0.8;
      // 裁切后角色可视底边 = charRect.bottom - clipBottom；应不越过桌沿下沿（容差 1px）。
      const visibleBottom = charRect.bottom - clipBottom;
      // 桌沿下方 40px 区间内的角色可视高度（应 ≤ 0）。
      const leakBelow = Math.max(0, Math.min(visibleBottom, tableEdge + 40) - tableEdge);
      return {
        ok: true as const,
        clipBottom,
        tableEdge,
        charBottom: charRect.bottom,
        visibleBottom,
        leakBelow,
      };
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 桌沿下沿以下角色不再渲染（裁切把可视底边抬到桌沿下沿或更高）。
      expect(result.visibleBottom).toBeLessThanOrEqual(result.tableEdge + 1);
      // 桌沿下方 40px 内角色基底层不透明像素数为 0（可视区不伸入该区间）。
      expect(result.leakBelow).toBe(0);
    }
    await shot(page, "live-rin-mobile-clipped");
  });
});
