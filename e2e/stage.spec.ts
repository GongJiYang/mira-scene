import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * S4 端到端（Mock 模式，自动启动 `pnpm dev`）。
 * 只断言结构与可见性，不做像素级比对；截图存到 `e2e/out/`。
 */

async function openStage(page: Page): Promise<void> {
  await page.goto("/");
  // 首次用户手势：解锁 AudioContext（iOS 要求）。
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("stage")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
}

async function submitText(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("text-input");
  await input.fill(text);
  await input.press("Enter");
}

async function waitIdle(page: Page): Promise<void> {
  await expect(page.getByTestId("stage")).toHaveAttribute("data-phase", "idle", { timeout: 20_000 });
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

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `e2e/out/${name}.png` });
}

test("1. 首屏：舞台可见、四态可切换、无横向滚动", async ({ page }, testInfo) => {
  const suffix = testInfo.project.name;
  await openStage(page);

  const stage = page.getByTestId("stage");
  await expect(stage).toBeVisible();
  await expect(page.getByTestId("stage-frame")).toBeVisible();
  await expect(stage).toHaveAttribute("data-phase", "idle");

  // 记录所有出现过的 phase：四态是瞬时的，用 MutationObserver 比轮询断言更可靠。
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="stage"]');
    const seen: string[] = [el?.getAttribute("data-phase") ?? ""];
    (window as unknown as { __phases: string[] }).__phases = seen;
    if (!el) return;
    new MutationObserver(() => {
      const value = el.getAttribute("data-phase") ?? "";
      if (seen[seen.length - 1] !== value) seen.push(value);
    }).observe(el, { attributes: true, attributeFilter: ["data-phase"] });
  });

  const layout = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement?.scrollWidth ?? 0,
    innerWidth: window.innerWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
  await shot(page, `1-idle-${suffix}`);

  // idle → listening
  await pressPtt(page);
  await expect(stage).toHaveAttribute("data-phase", "listening");
  await shot(page, `1-listening-${suffix}`);

  // 按住 ≥300ms（含 getUserMedia 的耗时余量）让录音有效，松开 → thinking → speaking
  await page.waitForTimeout(1_000);
  await releasePtt(page);

  // 服务端（Mock）回复 → speaking
  await expect(stage).toHaveAttribute("data-phase", "speaking", { timeout: 20_000 });
  await shot(page, `1-speaking-${suffix}`);

  const phases = await page.evaluate(() => (window as unknown as { __phases: string[] }).__phases);
  for (const expected of ["idle", "listening", "thinking", "speaking"]) {
    expect(phases, `四态里的 ${expected} 未出现，实际序列：${phases.join(" → ")}`).toContain(expected);
  }
});

test("2. 输入文字后出现字幕并进入 speaking", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-13", "只在移动端跑");
  await openStage(page);

  await submitText(page, "你好");
  await expect(page.getByTestId("stage")).toHaveAttribute("data-phase", "speaking", { timeout: 20_000 });
  await expect(page.getByTestId("subtitle")).not.toBeEmpty();
  await shot(page, "2-speaking");
});

test("3. 走到 reveal：雨停 / 推镜 / 拍立得 developing → shown", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-13", "只在移动端跑");
  await openStage(page);
  const stage = page.getByTestId("stage");

  // Mock 剧本：第 1 轮 arrive（不推进），第 2 轮 arrive→probe，第 3 轮 probe→reveal。
  await submitText(page, "你好");
  await waitIdle(page);
  await submitText(page, "你好");
  await waitIdle(page);
  await shot(page, "3-before-reveal");

  await submitText(page, "你在等谁？");
  await expect(stage).toHaveAttribute("data-phase", "speaking", { timeout: 20_000 });

  // 拍立得进入显影（空白相纸 → 照片）。
  await expect(stage).toHaveAttribute("data-photo", "developing", { timeout: 20_000 });
  await shot(page, "3-developing");

  // 雨停（背景切换）+ 推镜。
  await expect(stage).toHaveAttribute("data-fx", "rain_stop", { timeout: 20_000 });
  await expect(stage).toHaveAttribute("data-camera", "close_up");

  await expect(stage).toHaveAttribute("data-photo", "shown", { timeout: 20_000 });
  await expect(page.getByTestId("stage-photo")).toBeVisible();
  // 等显影（3s）走完再截图，便于人工核对。
  await page.waitForTimeout(3_300);
  await shot(page, "3-shown");
});

test("4. speaking 时打断：字幕立即消失（Q1）", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-13", "只在移动端跑");
  await openStage(page);
  const stage = page.getByTestId("stage");
  const subtitle = page.getByTestId("subtitle");

  await submitText(page, "你好");
  await expect(stage).toHaveAttribute("data-phase", "speaking", { timeout: 20_000 });
  await expect(subtitle).not.toBeEmpty();
  await shot(page, "4-speaking");

  await pressPtt(page);
  await expect(stage).toHaveAttribute("data-phase", "listening");
  await expect(subtitle).toBeEmpty();
  await shot(page, "4-interrupted");

  await releasePtt(page);
});

test("5. Q1：打断从按下到静音 ≤150ms（performance.mark 实测）", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-13", "只在移动端跑");
  await openStage(page);
  const stage = page.getByTestId("stage");

  await submitText(page, "你好");
  await expect(stage).toHaveAttribute("data-phase", "speaking", { timeout: 20_000 });

  // 按住 PTT：打断的有序执行器会在同一帧内打点 interrupt:start / audioStopped / mouthClosed。
  await pressPtt(page);
  await expect(stage).toHaveAttribute("data-phase", "listening");

  const timings = await page.evaluate(() => {
    const marks = performance.getEntriesByType("mark");
    const last = (name: string): number | null => {
      for (let index = marks.length - 1; index >= 0; index -= 1) {
        if (marks[index]?.name === name) return marks[index]?.startTime ?? null;
      }
      return null;
    };
    return {
      start: last("interrupt:start"),
      audioStopped: last("interrupt:audioStopped"),
      mouthClosed: last("interrupt:mouthClosed"),
    };
  });
  await releasePtt(page);

  expect(timings.start, "未找到 interrupt:start 打点").not.toBeNull();
  const toAudioMs = (timings.audioStopped ?? 0) - (timings.start ?? 0);
  const toMouthMs = (timings.mouthClosed ?? 0) - (timings.start ?? 0);
  expect(toAudioMs).toBeGreaterThanOrEqual(0);
  expect(toAudioMs).toBeLessThanOrEqual(150);
  expect(toMouthMs).toBeGreaterThanOrEqual(0);
  expect(toMouthMs).toBeLessThanOrEqual(150);

  mkdirSync("e2e/out", { recursive: true });
  writeFileSync("e2e/out/q1-timings.json", `${JSON.stringify({ toAudioStoppedMs: toAudioMs, toMouthClosedMs: toMouthMs }, null, 2)}\n`);
});
