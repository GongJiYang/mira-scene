import { expect, test, type Page } from "@playwright/test";

/**
 * freeze-fix8 §4：手机端三件事（iphone-13 项目）。
 *
 * ① 页面不请求任何 Google Fonts（fonts.googleapis.com / fonts.gstatic.com）——国内网络无法访问，
 *    会阻塞渲染导致白屏。
 * ② 短按麦克风（按下到松开 < 300ms）→ 出现「按住麦克风说话，松开发送」轻提示（录音会被丢弃）。
 * ③ 非安全上下文（`navigator.mediaDevices` 置 undefined）→ 按麦克风出现「不是 HTTPS」提示，
 *    且状态牌不变成倾听（不进入 listening）。
 *
 * Mock 服务由 playwright 配置启动；不发真实网络请求。
 */

async function openLive(page: Page): Promise<void> {
  await page.goto("/");
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
  await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle", { timeout: 20_000 });
}

test.describe("freeze-fix8 §4 手机端麦克风提示", () => {
  test("① 页面不请求 Google Fonts", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "iphone-13", "只在 iphone-13 项目运行");

    const googleFontRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com")) googleFontRequests.push(url);
    });

    await openLive(page);
    // 给潜在的字体请求一点时间落地（现在应当一个都没有）。
    await page.waitForTimeout(1_500);

    expect(googleFontRequests, "不应请求任何 Google Fonts").toEqual([]);
  });

  test("② 短按麦克风 → 出现 pttHoldHint", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "iphone-13", "只在 iphone-13 项目运行");
    await openLive(page);

    const ptt = page.getByTestId("ptt");
    const box = await ptt.boundingBox();
    if (!box) throw new Error("PTT 按钮不可见");

    // 短按：按下 → 立刻松开（< 300ms）。
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();

    const hint = page.getByTestId("mic-hint");
    await expect(hint).toBeVisible({ timeout: 3_000 });
    await expect(hint).toHaveText("按住麦克风说话，松开发送");
  });

  test("④ 输入栏空闲时不预留声波槽位，麦克风按钮贴右且按住不位移", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "iphone-13", "只在 iphone-13 项目运行");
    await openLive(page);

    const input = page.getByTestId("text-input");
    const ptt = page.getByTestId("ptt");

    const idlePtt = await ptt.boundingBox();
    const idleInput = await input.boundingBox();
    if (!idlePtt) throw new Error("PTT 按钮不可见");
    if (!idleInput) throw new Error("输入框不可见");

    // 空闲时麦克风按钮贴右：其右边缘距视口右边缘 ≤ 24px。
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("无视口尺寸");
    const idleRightGap = viewport.width - (idlePtt.x + idlePtt.width);
    expect(idleRightGap, "空闲时麦克风按钮应贴右侧（右边缘距视口右边缘 ≤ 24px）").toBeLessThanOrEqual(24);

    // 按住期间按钮 x 偏移 < 4px（声波出现不得挤动按钮）。
    const x = idlePtt.x + idlePtt.width / 2;
    const y = idlePtt.y + idlePtt.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();

    const holdingPtt = await ptt.boundingBox();
    if (!holdingPtt) throw new Error("按住期间 PTT 按钮不可见");
    expect(Math.abs(holdingPtt.x - idlePtt.x), "按住期间麦克风按钮 x 偏移应 < 4px").toBeLessThan(4);

    await page.mouse.up();

    // 空闲与录音时输入栏布局一致：输入框宽度不受声波槽位影响。
    const afterPtt = await ptt.boundingBox();
    const afterInput = await input.boundingBox();
    if (!afterPtt || !afterInput) throw new Error("松开后控件不可见");
    expect(Math.abs(afterPtt.x - idlePtt.x), "松开后麦克风按钮 x 不应位移").toBeLessThan(1);
    expect(Math.abs(afterInput.width - idleInput.width), "松开后输入框宽度应恢复原状").toBeLessThan(1);
  });

  test("③ 非安全上下文 → micUnavailableHint，且状态牌不变 listen", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "iphone-13", "只在 iphone-13 项目运行");

    // 模拟非 HTTPS：浏览器不提供 navigator.mediaDevices。
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, get: () => undefined });
    });

    await openLive(page);

    const ptt = page.getByTestId("ptt");
    const box = await ptt.boundingBox();
    if (!box) throw new Error("PTT 按钮不可见");

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();

    const hint = page.getByTestId("mic-hint");
    await expect(hint).toBeVisible({ timeout: 3_000 });
    await expect(hint).toHaveText("当前页面不是 HTTPS，浏览器不允许录音；可以先发弹幕聊天");

    // 按住期间状态牌不得变成倾听。
    const chip = page.getByTestId("state-chip");
    await expect(chip).not.toHaveAttribute("data-tone", "listen");
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle");

    await page.mouse.up();
  });
});
