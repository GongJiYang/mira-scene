import { expect, test, type Page } from "@playwright/test";

/**
 * freeze-fix4 §3：桌面「按住说话」不因布局变化被提前结束。
 *
 * 根因：PTT 按钮绑定了 onPointerLeave；按下后按钮左移约 90px，
 * 指针落在按钮外 → pointerleave → 立刻 pttUp，录音 <300ms 被丢弃。
 *
 * 断言：
 * 1. 在按钮右侧 80% 处按下，按住 2s 再松开 → 进入过 listening，且 2s 内没有提前回到 idle / thinking。
 * 2. 按下前后 PTT 按钮 boundingBox 的 x 偏移 < 4px（按钮位置不因「正在听」/声波而移动）。
 */

async function openLive(page: Page): Promise<void> {
  await page.goto("/");
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
  await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle", { timeout: 20_000 });
}

test.describe("freeze-fix4 §3 桌面按住说话", () => {
  test("按钮右侧 80% 处按住 2s 不被提前结束，且按钮位置不变", async ({ page }, testInfo) => {
    // §3：本 spec 只针对桌面项目（按钮位移 + pointerleave 提前结束的 bug 在桌面复现）。
    test.skip(testInfo.project.name !== "desktop", "只在 desktop 项目运行");
    await openLive(page);

    const ptt = page.getByTestId("ptt");
    const box = await ptt.boundingBox();
    if (!box) throw new Error("PTT 按钮不可见");

    // 按钮右侧 80% 处（原 bug 正是按在这里：按钮左移后指针落到按钮外）。
    const startX = box.x + box.width * 0.8;
    const startY = box.y + box.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();

    // 进入倾听。
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "listening", { timeout: 5_000 });

    // 按住期间记录按钮位置：与按下前比较，x 偏移必须 < 4px。
    const boxWhileHolding = await ptt.boundingBox();
    if (!boxWhileHolding) throw new Error("按住期间 PTT 按钮不可见");
    expect(Math.abs(boxWhileHolding.x - box.x)).toBeLessThan(4);

    // 持续 2s，期间不得提前回到 idle / thinking。
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const phase = await page.getByTestId("live").getAttribute("data-phase");
      expect(phase, "按住期间阶段应保持 listening").toBe("listening");
      await page.waitForTimeout(100);
    }

    await page.mouse.up();
  });
});
