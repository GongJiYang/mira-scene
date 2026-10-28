import { expect, test, type Page } from "@playwright/test";

/**
 * freeze-fix7 §3：手机端人物尺寸回归（真实布局像素包围盒）。
 *
 * 背景：freeze-fix1 §5.2 给手机画布写了 `height: auto`。`<canvas>` 是替换元素，
 * `height: auto` 取的是 canvas 固有宽高比（来自 width/height 属性），**不会被 top/bottom 撑开**，
 * 于是画布 CSS 尺寸与渲染器 `resize(canvas.clientWidth, canvas.clientHeight)` / `fitModel` 的取景
 * 不一致，人物被缩小并错位。freeze-fix1 的 `yunaFit.test.ts` 只测纯函数，测不到这一层。
 *
 * 本用例在真实布局里：
 * - 断言画布 `clientHeight` 与 `getBoundingClientRect().height` 相等，且 ≈ 视口高度 − 顶部偏移（< 2px）；
 * - 对画布做 `readPixels` 求不透明像素包围盒：高度 ≥ 视口高度 × 0.5，顶部 ≥ 标题胶囊底部。
 *
 * 只跑 iphone-13 项目（手机竖屏）；在 390×844 / 430×932 / 360×780 三个视口参数化。
 * 修复前应失败。
 */

/** 打开直播间（Mock 服务由 playwright 配置启动；不发真实网络请求）。 */
async function openLive(page: Page): Promise<void> {
  await page.goto("/");
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
}

/**
 * 读画布不透明像素的包围盒（CSS 像素，原点在**左上**，+ 向下）。
 * `readPixels` 原点在左下，这里翻转到屏幕方向，方便与 DOM 的 rect 比较。
 */
async function opaqueBBox(page: Page): Promise<{
  width: number;
  height: number;
  bboxTop: number;
  bboxHeight: number;
  bboxLeft: number;
  bboxWidth: number;
  opaquePixels: number;
} | null> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="yuna-canvas"]');
    const gl = canvas?.getContext("webgl");
    if (!canvas || !gl) return null;
    const w = canvas.width;
    const h = canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const opaque = (x: number, y: number): boolean => pixels[(y * w + x) * 4 + 3] > 16;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    let opaquePixels = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!opaque(x, y)) continue;
        opaquePixels += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const rect = canvas.getBoundingClientRect();
    // readPixels 原点在左下：屏幕顶部对应像素 y = h - 1 - maxY。
    const scaleY = rect.height / h;
    const scaleX = rect.width / w;
    const bboxTop = rect.top + (h - 1 - maxY) * scaleY;
    const bboxBottom = rect.top + (h - 1 - minY) * scaleY;
    return {
      width: w,
      height: h,
      bboxTop,
      bboxHeight: bboxBottom - bboxTop,
      bboxLeft: rect.left + minX * scaleX,
      bboxWidth: (maxX - minX + 1) * scaleX,
      opaquePixels,
    };
  });
}

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "360x780", width: 360, height: 780 },
] as const;

test.describe("freeze-fix7 §3 手机端人物尺寸", () => {
  for (const viewport of VIEWPORTS) {
    test(`画布高度贴合视口、人物包围盒 ≥ 50% 视口高且不被标题胶囊遮挡（${viewport.name}）`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openLive(page);

      const canvas = page.getByTestId("yuna-canvas");
      await expect(canvas).toBeVisible({ timeout: 20_000 });
      // 等模型 + 呼吸 / 物理稳定。
      await page.waitForTimeout(3_000);

      // 1）画布 CSS 尺寸自洽：clientHeight == rect.height，且 ≈ 视口高 − 顶部偏移。
      const box = await page.evaluate(() => {
        const el = document.querySelector<HTMLCanvasElement>('[data-testid="yuna-canvas"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const top = Number.parseFloat(getComputedStyle(el).top) || 0;
        return { clientHeight: el.clientHeight, rectHeight: rect.height, topOffset: top };
      });
      expect(box, "画布不可测量").not.toBeNull();
      if (!box) return;
      expect(box.clientHeight, "画布 clientHeight 与 rect.height 不一致（替代元素高度塌陷）").toBeCloseTo(
        box.rectHeight,
        0,
      );
      const expectedHeight = viewport.height - box.topOffset;
      expect(
        Math.abs(box.clientHeight - expectedHeight),
        `画布高度应 ≈ 视口高(${viewport.height}) − 顶部偏移(${box.topOffset})`,
      ).toBeLessThan(2);

      // 2）像素包围盒：高度 ≥ 视口高 × 0.5；顶部 ≥ 标题胶囊底部。
      const stats = await opaqueBBox(page);
      expect(stats, "画布不可读").not.toBeNull();
      if (!stats) return;
      expect(stats.opaquePixels, "画布没有渲染出任何像素").toBeGreaterThan(1_000);

      const header = await page.getByTestId("story-header").boundingBox();
      expect(header, "标题胶囊不可测量").not.toBeNull();
      const headerBottom = header ? header.y + header.height : 0;

      expect(
        stats.bboxHeight,
        `人物包围盒高度 ${stats.bboxHeight.toFixed(1)}px 应 ≥ 视口高 ${viewport.height} 的 50%`,
      ).toBeGreaterThanOrEqual(viewport.height * 0.5);
      expect(
        stats.bboxTop,
        `人物包围盒顶部 ${stats.bboxTop.toFixed(1)}px 应 ≥ 标题胶囊底部 ${headerBottom.toFixed(1)}px`,
      ).toBeGreaterThanOrEqual(headerBottom);
    });
  }
});
