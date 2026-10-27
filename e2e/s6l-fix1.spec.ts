import { expect, test, type Page } from "@playwright/test";

/**
 * S6l-fix1 §3：刷新恢复的端到端（Mock 模式）。
 *
 * 发一条消息 → 触发换背景并等到成功 → `page.reload()` → 断言背景仍是生成图、
 * 用户刚发的弹幕仍在、剧情进度不变。
 *
 * 注意：按用户 2026-10-28 的决定，本批不运行 `pnpm e2e`（只在冻结点统一跑一次）。
 * 本用例已写好但**未运行**。
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

test.describe("S6l-fix1 §3 刷新恢复", () => {
  test("换背景成功后刷新：背景仍是生成图、用户弹幕仍在、剧情进度不变", async ({ page }) => {
    await openLive(page);

    // 先发一轮推进剧情（arrive → probe），并让用户弹幕进入列表。
    await submitText(page, "你好");
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle", { timeout: 30_000 });
    await submitText(page, "在吗");
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle", { timeout: 30_000 });
    await expect(page.getByTestId("story-header")).toHaveAttribute("data-node", "probe", { timeout: 20_000 });
    const nodeBefore = await page.getByTestId("story-header").getAttribute("data-node");

    // 触发换背景并等成功（Mock 模式立即 ready）。
    await submitText(page, "换背景到海边");
    await expect(page.getByTestId("scene-status")).toHaveAttribute("data-kind", "ready", { timeout: 30_000 });
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle", { timeout: 30_000 });

    // 记录当前背景（生成图 URL）。
    const backgroundBefore = await page.evaluate(() => {
      const el = document.querySelector('[data-bg-layer="base"]') as HTMLElement | null;
      return el?.style.backgroundImage ?? "";
    });
    expect(backgroundBefore).toContain("/generated/");

    // 刷新。
    await page.reload();
    await page.mouse.click(4, 4);
    await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });

    // 背景仍是生成图（刷新恢复直接显示，不播淡入）。
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const el = document.querySelector('[data-bg-layer="base"]') as HTMLElement | null;
            return el?.style.backgroundImage ?? "";
          }),
        { timeout: 20_000 },
      )
      .toContain("/generated/");

    // 用户弹幕仍在（恢复进弹幕列表）。
    await expect(page.getByTestId("danmaku-list")).toContainText("你好");
    await expect(page.getByTestId("danmaku-list")).toContainText("换背景到海边");

    // 剧情进度不变。
    await expect(page.getByTestId("story-header")).toHaveAttribute("data-node", nodeBefore ?? "probe");
  });
});
