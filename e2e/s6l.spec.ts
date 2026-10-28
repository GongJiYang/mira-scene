import { expect, test, type Page } from "@playwright/test";

/**
 * S6l §2/§3/§5/§6：剧情可感知 + 轻互动的端到端（Mock 模式）。
 *
 * - §2：顶部标题随剧情节点变化（arrive → probe），4 个进度点。
 * - §3：idle 约 8 秒后出现观众引导弹幕，可点击 → 作为用户弹幕发送。
 * - §5：点「送礼物」→ 出现爱心特效（fx-hearts）。
 * - §6：忧奈说话时点画面 → 打断，进入倾听。
 */

async function openLive(page: Page): Promise<void> {
  await page.goto("/");
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
}

async function submitText(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("text-input");
  await input.fill(text);
  await input.press("Enter");
}

async function waitIdle(page: Page): Promise<void> {
  await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle", { timeout: 30_000 });
}

const layoutOf = (testInfo: { project: { name: string } }): "desktop" | "mobile" =>
  testInfo.project.name === "desktop" ? "desktop" : "mobile";

test.describe("S6l §2 顶部剧情阶段", () => {
  test("标题随节点从 arrive 变到 probe", async ({ page }) => {
    await openLive(page);
    await expect(page.getByTestId("story-header")).toHaveAttribute("data-node", "arrive");
    await expect(page.getByTestId("story-title")).toHaveText("下播后 · 推流未关");

    // arrive → probe 需要「用户说过至少 1 轮」（与 Mock 一致）：发两轮。
    await submitText(page, "你好");
    await waitIdle(page);
    await submitText(page, "在吗");
    await waitIdle(page);
    await expect(page.getByTestId("story-header")).toHaveAttribute("data-node", "probe", { timeout: 20_000 });
    await expect(page.getByTestId("story-title")).toHaveText("还有一位观众没走");
  });
});

test.describe("S6l §3 观众引导弹幕", () => {
  test("idle 约 8 秒后出现引导弹幕，可点击发送", async ({ page }) => {
    await openLive(page);
    await waitIdle(page);

    // 8 秒节奏：最多等 ~14 秒出现第一条引导。
    const guide = page.getByTestId("guide-danmaku").first();
    await expect(guide).toBeVisible({ timeout: 14_000 });

    // 取引导的**弹幕正文**（`.live-danmaku-text`），不依赖昵称 / 前缀 / 换行格式。
    const text = (await guide.locator(".live-danmaku-text").innerText()).trim();
    expect(text.length).toBeGreaterThan(0);

    // 点击引导 → 作为用户弹幕发送。
    await guide.click();
    // 断言弹幕区出现了「你」发出的该句文本（不依赖换行格式）。
    const list = page.getByTestId("danmaku-list");
    await expect(list).toContainText(text, { timeout: 10_000 });
    await expect(list.locator(".live-danmaku-nick-user").first()).toHaveText("你", { timeout: 10_000 });
  });
});

test.describe("S6l §5/§6 互动", () => {
  test("送礼物 → 出现爱心特效", async ({ page }) => {
    await openLive(page);
    await waitIdle(page);
    await page.getByTestId("gift").click();
    await expect(page.getByTestId("fx-hearts")).toBeVisible({ timeout: 20_000 });
  });

  test("忧奈说话时点画面 → 打断进入倾听", async ({ page }, testInfo) => {
    await openLive(page);
    await submitText(page, "你好");

    // 等到说话。
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "speaking", { timeout: 20_000 });

    if (layoutOf(testInfo) === "desktop") {
      // 桌面：点画面（tap 层）→ 打断。
      const stage = page.getByTestId("live-stage");
      const box = await stage.boundingBox();
      if (!box) throw new Error("live-stage 不可见");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      // 手机：短按（无位移）→ 打断。
      const stage = page.getByTestId("live-mobile");
      const box = await stage.boundingBox();
      if (!box) throw new Error("live-mobile 不可见");
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    }

    // 打断后进入倾听（字幕清空）。
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "listening", { timeout: 10_000 });
  });
});
