import { expect, test, type Page } from "@playwright/test";

/**
 * freeze-fix6 §3：情景化兜底不再卡死（真实 / Mock 都受影响）。
 *
 * 根因：服务端兜底 beat 只有文字、不发 tts_audio；`pickNextPlayable` 对「有 say、无音频就绪、
 * 未 TTS 降级」的 beat 返回 null，客户端永远等音频，字幕停在「...」，约 40s 后才回 idle。
 *
 * 本用例走 Mock 服务（playwright 配置启动），打开 `/?fail=llm_timeout` 发一条弹幕：
 * 25s 内字幕出现角色包 `llm_timeout` 台词，且随后回到 idle（state-chip data-tone="idle"）。
 * 只针对 desktop 项目运行。
 */

/** 忧奈角色包的 llm_timeout 兜底台词（内容与 characters/yuna/content.json 一致，不改台词）。 */
const LLM_TIMEOUT_LINE = "……抱歉，刚刚发呆了。你说到哪了？";

async function openLiveWithFault(page: Page): Promise<void> {
  await page.goto("/?fail=llm_timeout");
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
  // 抽到 idle 后再发弹幕，避免状态相互干扰。
  await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle", { timeout: 20_000 });
}

test.describe("freeze-fix6 §3 兜底不卡死", () => {
  test("llm_timeout 兜底台詞出现并回到 idle", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "只在 desktop 项目运行");
    await openLiveWithFault(page);

    const input = page.getByTestId("text-input");
    await input.fill("你好");
    await input.press("Enter");

    // 弹幕进列表。
    await expect(page.getByTestId("danmaku-list")).toContainText("你好");

    // 25s 内字幕出现角色包的 llm_timeout 兜底台词。
    await expect(page.getByTestId("subtitle")).toHaveText(LLM_TIMEOUT_LINE, { timeout: 25_000 });

    // 随后回到 idle（状态牌 data-tone="idle"）。
    await expect(page.getByTestId("state-chip")).toHaveAttribute("data-tone", "idle", { timeout: 25_000 });
  });
});
