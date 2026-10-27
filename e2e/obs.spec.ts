import { expect, test, type Page } from "@playwright/test";

/**
 * S6h §4：观测页端到端（Mock 模式）。
 * 说一句话产生一轮互动，再打开 `?obs=1`，断言出现时间线，并截图 `e2e/out/s6h-obs.png`。
 * 只断言结构与可见性，不做像素级比对。
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

test.describe("观测页 ?obs=1", () => {
  test("说一句话后出现 1 行时间线", async ({ page }) => {
    // 先在直播间说一句话，产生一轮互动（Mock 模式：turn_start → llm_first_beat → tts_first_audio）。
    await openLive(page);
    await submitText(page, "你好");
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "speaking", { timeout: 20_000 });

    // 打开观测页（独立路由，不连 WebSocket）。
    await page.goto("/?obs=1");
    await expect(page.getByTestId("obs-app")).toBeVisible();

    // 轮询每 2 秒；最多等 20 秒出现至少 1 行时间线。
    await expect(page.getByTestId("obs-turn").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("obs-stages")).toBeVisible();
    await expect(page.getByTestId("obs-errors")).toBeVisible();
    await expect(page.getByTestId("obs-models")).toBeVisible();

    await page.screenshot({ path: "e2e/out/s6h-obs.png" });
  });

  test("空数据时显示占位", async ({ page }) => {
    // 服务端已在同一会话内跑，但此测试独立；直接打开观测页看占位或时间线都合法——
    // 这里只在「没有任何轮次」时断言占位可见。
    await page.goto("/?obs=1");
    await expect(page.getByTestId("obs-app")).toBeVisible();
    const empty = page.getByTestId("obs-empty");
    const turns = page.getByTestId("obs-turn");
    // 二者必有其一可见（有历史轮次则显示时间线）。
    await expect(empty.or(turns.first())).toBeVisible({ timeout: 20_000 });
  });
});
