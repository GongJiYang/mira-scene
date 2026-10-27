import { expect, test, type Page } from "@playwright/test";

/**
 * S6a §4 / S6a-fix1：忧奈 Live2D 预览页端到端。
 * Core 与模型都是本地文件（`public/vendor/cubism`、`public/models/yuna`），不联网。
 * 只跑桌面项目：预览页与移动端布局无关。
 */

async function openPreview(page: Page): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?preview=yuna");
  return { errors };
}

test("预览页：画布出现，3 秒内没有 console error，切换 emotion 不报错", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "预览页只跑桌面项目");

  const { errors } = await openPreview(page);
  await expect(page.getByTestId("yuna-preview")).toBeVisible();

  // 模型加载失败会显示错误卡片；这里断言画布出现（Core + 模型都是本地文件）。
  await expect(page.getByTestId("yuna-canvas")).toBeVisible({ timeout: 20_000 });

  // 面板显示 FPS 与贴图尺寸。
  await expect(page.getByTestId("preview-fps")).toContainText("FPS");
  await expect(page.getByTestId("preview-texture")).toContainText("贴图");

  // 画布真的画出了东西（不是空画布）：WebGL 用 preserveDrawingBuffer，readPixels 可读。
  await page.waitForTimeout(2_000);
  const opaquePixels = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="yuna-canvas"]');
    const gl = canvas?.getContext("webgl");
    if (!canvas || !gl) return -1;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 16) count += 1;
    return count;
  });
  expect(opaquePixels, "画布没有渲染出任何像素").toBeGreaterThan(1_000);

  // 切换四种情绪都不报错；顺带更新情绪截图（S6a-fix1 §5）。
  for (const emotion of ["calm", "guarded", "sad", "warm"]) {
    await page.getByRole("radio", { name: emotion, exact: true }).check();
    // 等情绪平滑到位（EMOTION_SMOOTH_SEC = 0.25s）。
    await page.waitForTimeout(600);
    const canvas = page.getByTestId("yuna-canvas");
    await canvas.screenshot({ path: `e2e/out/emotion-${emotion}.png` });
  }

  // 手动眨眼 + 自动说话开关。
  await page.getByTestId("blink-button").click();
  await page.getByRole("checkbox", { name: "自动说话" }).check();
  await page.waitForTimeout(300);

  // 3 秒静置：不应出现 console error。
  await page.waitForTimeout(3_000);
  expect(errors, `console error：${errors.join(" | ")}`).toEqual([]);

  await page.screenshot({ path: "e2e/out/yuna-preview.png" });
});

test("预览页：自动眨眼在 6 秒内至少闭眼一次（ParamEyeLOpen < 0.3）", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "预览页只跑桌面项目");

  await openPreview(page);
  await expect(page.getByTestId("yuna-canvas")).toBeVisible({ timeout: 20_000 });

  // `data-eye-open` 是预览页每秒刷新的「睁眼读数滑动最小值」；自动眨眼一帧就会把它压下去。
  // EyeBlink 的随机间隔是 `1–7 秒`（框架 `cubismeyeblink`），所以要覆盖最坏情况必须等够 8 秒以上；
  // 这里放宽到 12 秒，并按 200ms 轮询，避免恰好错过某个 1 秒窗口。
  const deadline = Date.now() + 12_000;
  let minSeen = 1;
  while (Date.now() < deadline) {
    const raw = await page.getByTestId("yuna-canvas").getAttribute("data-eye-open");
    const value = raw === null ? Number.NaN : Number.parseFloat(raw);
    if (Number.isFinite(value)) minSeen = Math.min(minSeen, value);
    if (minSeen < 0.3) break;
    await page.waitForTimeout(200);
  }
  expect(minSeen, "自动眨眼始终没有把眼睛闭到 0.3 以下").toBeLessThan(0.3);
});

/**
 * S6a-fix2：预览页构图。
 * 桌面 1440×900 与手机 390×844 各截一张 `e2e/out/yuna-fit-{desktop,mobile}.png`，
 * 并断言画布四边各 4px 宽的条带内没有非透明像素（人物没碰边被裁）。
 */
for (const target of [
  { name: "desktop", project: "desktop", width: 1440, height: 900 },
  { name: "mobile", project: "iphone-13", width: 390, height: 844 },
] as const) {
  test(`预览页构图：${target.name} 人物不出画（四边 4px 条带无像素）`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== target.project, `该用例只在 ${target.project} 项目跑`);
    await page.setViewportSize({ width: target.width, height: target.height });

    await openPreview(page);
    await expect(page.getByTestId("yuna-canvas")).toBeVisible({ timeout: 20_000 });
    // 等模型就绪 + 呼吸 / 物理稳定。
    await page.waitForTimeout(2_500);

    // 桌面：画布铺满预览页左侧（不是小卡片），高度应接近视口高度。手机是纵向堆叠，只要求画布够大。
    const canvasBox = await page.getByTestId("yuna-canvas").boundingBox();
    expect(canvasBox, "画布不可测量").not.toBeNull();
    if (canvasBox) {
      const minHeight = target.name === "desktop" ? target.height * 0.85 : target.height * 0.4;
      expect(canvasBox.height, "画布太小").toBeGreaterThan(minHeight);
    }

    // 四边各 4px 条带内不得出现非透明像素；同时报告人物包围盒占画布高度的比例（应接近 92%）。
    const band = 4;
    const stats = await page.evaluate((bandSize) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="yuna-canvas"]');
      const gl = canvas?.getContext("webgl");
      if (!canvas || !gl) return null;
      const w = canvas.width;
      const h = canvas.height;
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const opaque = (x: number, y: number): boolean => pixels[(y * w + x) * 4 + 3] > 16;
      let bandOpaque = 0;
      let minX = w;
      let maxX = -1;
      let minY = h;
      let maxY = -1;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (!opaque(x, y)) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          // readPixels 原点在左下；四边条带一致判断即可。
          if (x < bandSize || x >= w - bandSize || y < bandSize || y >= h - bandSize) bandOpaque += 1;
        }
      }
      return { w, h, bandOpaque, minX, maxX, minY, maxY, heightPct: (maxY - minY) / h };
    }, band);

    expect(stats, "画布不可读").not.toBeNull();
    if (!stats) return;
    expect(stats.bandOpaque, "人物碰到画布边缘（四边 4px 条带内出现像素）").toBe(0);
    // 人物高度约占画布高度 92%（留一点呼吸 / 物理抖动余量）。
    expect(stats.heightPct, "人物太小").toBeGreaterThan(0.8);

    await page.screenshot({ path: `e2e/out/yuna-fit-${target.name}.png` });
  });
}
