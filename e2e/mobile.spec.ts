import { expect, test, type Page } from "@playwright/test";
import { FACE_BOX, rectsIntersect, type Rect } from "../apps/client/src/stage/photoRect";

/**
 * S5 §3 / §5：移动端适配与剧情视频的端到端。
 *
 * 三种视口（iPhone SE / iPhone 13 / 桌面 1280×800）在本文件内用 `test.use` 切换，
 * 只在一个 Playwright project 下运行，避免三倍重复。全部 Mock 模式，不发真实网络请求、不读 Key。
 */

const VIEWPORTS = [
  {
    name: "iphone-se",
    use: { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  },
  {
    name: "iphone-13",
    use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  },
  {
    name: "desktop-1280x800",
    use: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  },
] as const;

async function openStage(page: Page, query = ""): Promise<void> {
  // S6b §4：默认渲染新直播间 UI；本文件测旧 Stage 行为，统一追加 legacy=1。
  const qs = query.startsWith("?") ? query.slice(1) : query;
  const params = qs === "" ? "legacy=1" : `${qs}&legacy=1`;
  await page.goto(`/?${params}`);
  await page.mouse.click(4, 4); // 首次手势：解锁 AudioContext
  await expect(page.getByTestId("stage")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
}

async function submitText(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("text-input");
  await input.fill(text);
  await input.press("Enter");
}

async function waitIdle(page: Page): Promise<void> {
  await expect(page.getByTestId("stage")).toHaveAttribute("data-phase", "idle", { timeout: 30_000 });
}

async function pressPtt(page: Page): Promise<void> {
  const ptt = page.getByTestId("ptt");
  await ptt.scrollIntoViewIfNeeded();
  await ptt.hover();
  await page.mouse.down();
}

async function releasePtt(page: Page): Promise<void> {
  await page.mouse.up();
}

/** Mock 剧本：第 2 轮 arrive→probe，第 3 轮 probe→reveal。 */
async function reachReveal(page: Page): Promise<void> {
  await submitText(page, "你好");
  await waitIdle(page);
  await submitText(page, "你好");
  await waitIdle(page);
  await submitText(page, "你在等谁？");
}

/** 第 3 轮进 reveal，第 4 轮进 ending（ending 会触发 `clip_ending` 视频）。 */
async function reachEnding(page: Page): Promise<void> {
  await reachReveal(page);
  await waitIdle(page);
  await submitText(page, "你好");
  await waitIdle(page);
}

for (const viewport of VIEWPORTS) {
  test.describe(`视口 ${viewport.name}`, () => {
    test.use(viewport.use);

    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name !== "iphone-13", "三种视口在本文件内切换，只在一个 project 下运行");
    });

    test(`无横向滚动、背景用 _v 素材、照片放大后不挡脸（${viewport.name}）`, async ({ page }) => {
      test.setTimeout(120_000);
      await openStage(page);

      // §3：任何视口下都不出现横向滚动。
      const layout = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);

      // §4 ①：舞台框永远 2:3 → 背景必须用 `_v` 素材（横屏窗口也一样）。
      const backgroundSources = await page
        .locator('[data-testid="stage-frame"] .stage-bg img')
        .evaluateAll((images) => images.map((image) => image.getAttribute("src") ?? ""));
      expect(backgroundSources.length).toBeGreaterThan(0);
      expect(backgroundSources.every((src) => src.includes("_v"))).toBe(true);

      // §4 ②：把剧情推到 reveal，照片会放大居中。
      await reachReveal(page);
      const photo = page.getByTestId("stage-photo");
      await expect(photo).toHaveAttribute("data-mode", "center", { timeout: 30_000 });

      // 照片（放大态）的包围盒 vs faceBox 换算出的像素区域：必须不相交。
      const measured = await page.evaluate(() => {
        const frameEl = document.querySelector('[data-testid="stage-frame"]') as HTMLElement | null;
        const photoEl = document.querySelector('[data-testid="stage-photo"]') as HTMLElement | null;
        if (!frameEl || !photoEl) return null;
        const frame = frameEl.getBoundingClientRect();
        const box = photoEl.getBoundingClientRect();
        return {
          frame: { left: frame.left, top: frame.top, width: frame.width, height: frame.height },
          photo: { left: box.left, top: box.top, width: box.width, height: box.height },
        };
      });
      expect(measured).not.toBeNull();

      const frame = measured!.frame;
      const photoRect: Rect = measured!.photo;
      const faceRect: Rect = {
        left: frame.left + FACE_BOX.left * frame.width,
        top: frame.top + FACE_BOX.top * frame.height,
        width: FACE_BOX.width * frame.width,
        height: FACE_BOX.height * frame.height,
      };
      expect(rectsIntersect(photoRect, faceRect), `照片挡住脸（${JSON.stringify({ photoRect, faceRect })}`).toBe(false);
    });
  });
}

test.describe("S5 §5 剧情视频", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "iphone-13", "视频用例只在一个 project 下跑一次");
  });

  test("进入 ending 后视频出现；播放中被按住说话打断，300ms 内不可见且不恢复", async ({ page }) => {
    test.setTimeout(150_000);
    await openStage(page);
    const stage = page.getByTestId("stage");
    const video = page.getByTestId("story-video");

    await reachEnding(page);

    // 加载中：视频层不可见（常驻角色照常），随后 canplay → playing。
    await expect(video).toHaveAttribute("data-status", "playing", { timeout: 30_000 });
    await expect(video).toBeVisible();

    // S6a §3 ②：视频不占照片槽位 —— reveal 的照片在视频播放期间仍然在。
    await expect(page.getByTestId("stage-photo")).toHaveCount(1);

    // 中途打断：按住说话 → 视频立即暂停并淡出，不恢复。
    await pressPtt(page);
    await expect(video).toBeHidden({ timeout: 300 });
    await expect(stage).toHaveAttribute("data-phase", "listening");
    await releasePtt(page);

    // 不恢复：等一会儿仍然是隐藏的；照片也仍在（打断时照片保留，D37）。
    await page.waitForTimeout(1_000);
    await expect(video).toBeHidden();
    await expect(page.getByTestId("stage-photo")).toHaveCount(1);
  });
});

test.describe("S5 §5 视频失败降级", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "iphone-13", "视频用例只在一个 project 下跑一次");
  });

  test("?fail=video → 视频不出现，改为静态图 + 轻提示", async ({ page }) => {
    test.setTimeout(150_000);
    await openStage(page, "?fail=video");
    const video = page.getByTestId("story-video");
    const fallback = page.getByTestId("video-fallback");
    const notice = page.getByTestId("video-notice");

    await reachEnding(page);

    await expect(fallback).toBeVisible({ timeout: 30_000 });
    await expect(notice).toBeVisible();
    await expect(video).toHaveCount(0);
  });
});
