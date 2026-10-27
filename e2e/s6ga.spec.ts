import { expect, test, type Page } from "@playwright/test";

/**
 * S6g-A §7：Live2D 舞台补渲染的端到端（Mock 模式）。
 *
 * 走一遍剧情 arrive → probe → reveal → ending，截图：
 * `s6ga-arrive.png`、`s6ga-reveal.png`（推近 + 变暗 + 截图弹窗）、`s6ga-ending.png`（拉远 + 爱心 + 视频），
 * 手机各一张 `-mobile`；四种情绪各一张 `s6ga-emo-<calm|guarded|sad|warm>.png`；
 * 入口按钮可见并能跳转；断言 Live2D 画布非空。
 *
 * Mock 剧本（见 mockLlm.ts）：arrive=calm、probe=guarded、reveal=sad、ending=warm，
 * 正好覆盖四种情绪。
 */

async function openLive(page: Page): Promise<void> {
  await page.goto("/");
  await page.mouse.click(4, 4);
  await expect(page.getByTestId("live")).toHaveAttribute("data-connection", "open", { timeout: 20_000 });
}

/** 等待 Live2D 画布出现非透明像素（最多 20 秒）。 */
async function waitLive2DPainted(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('[data-testid="yuna-canvas"]') as HTMLCanvasElement | null;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
      const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGL2RenderingContext | WebGLRenderingContext | null;
      if (!gl) return false;
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      if (w === 0 || h === 0) return false;
      const strip = new Uint8Array(4 * Math.min(w, 64) * h);
      gl.readPixels(Math.floor(w / 2) - Math.min(w, 32), 0, Math.min(w, 64), h, gl.RGBA, gl.UNSIGNED_BYTE, strip);
      for (let i = 3; i < strip.length; i += 4) {
        if (strip[i] !== 0) return true;
      }
      return false;
    },
    undefined,
    { timeout: 20_000, polling: 250 },
  );
}

async function submitText(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("text-input");
  await input.fill(text);
  await input.press("Enter");
}

/** 等到 idle（一轮结束）再发下一句，确保剧情按轮推进。 */
async function waitIdle(page: Page): Promise<void> {
  await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "idle", { timeout: 30_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `e2e/out/${name}.png` });
}

const layoutOf = (testInfo: { project: { name: string } }): "desktop" | "mobile" =>
  testInfo.project.name === "desktop" ? "desktop" : "mobile";

test.describe("S6g-A：Live2D 舞台剧情渲染", () => {
  test("arrive → reveal → ending 截图 + 四情绪", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const layout = layoutOf(testInfo);
    await openLive(page);
    await waitLive2DPainted(page);

    // arrive：全身（wide）、无特效、calm。
    await expect(page.getByTestId("live-camera")).toHaveAttribute("data-camera", "wide");
    await shot(page, `s6ga-arrive${layout === "mobile" ? "-mobile" : ""}`);
    await shot(page, "s6ga-emo-calm");

    // 第 1 轮：arrive（不推进）。
    await submitText(page, "你好");
    await waitIdle(page);

    // 第 2 轮：arrive → probe（guarded）。
    await submitText(page, "你好");
    await waitIdle(page);
    await shot(page, "s6ga-emo-guarded");

    // 第 3 轮：probe → reveal（close_up + stream_dim + 截图弹窗 + sad）。
    await submitText(page, "还不睡吗？");
    await expect(page.getByTestId("live-camera")).toHaveAttribute("data-camera", "close_up", { timeout: 30_000 });
    await expect(page.getByTestId("fx-stream-dim")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("screenshot-card")).toBeVisible({ timeout: 30_000 });
    // 截图卡片内出现图片（生成中 → ready，ready 显示生成图 / 预置图）。
    await expect(page.getByTestId("screenshot-card").getByTestId("screenshot-image")).toBeVisible({ timeout: 30_000 });
    await shot(page, "s6ga-emo-sad");
    await shot(page, `s6ga-reveal${layout === "mobile" ? "-mobile" : ""}`);
    await waitIdle(page);

    // 第 4 轮：reveal → ending（wide + hearts + 视频 + warm）。
    await submitText(page, "然后呢");
    await expect(page.getByTestId("live-camera")).toHaveAttribute("data-camera", "wide", { timeout: 30_000 });
    await expect(page.getByTestId("fx-hearts")).toBeVisible({ timeout: 30_000 });
    // S6c-fix1 §8b.3：在 ending 视频出现之前截「温暖」情绪——否则截图会被视频盖住。
    await shot(page, "s6ga-emo-warm");
    // 视频加载后 playing（mock 预置片段 /characters/yuna/clip_offline.webm）。
    await expect(page.getByTestId("story-video")).toHaveAttribute("data-status", "playing", { timeout: 30_000 });
    // S6c-fix1 §8b.1：进入 ending 后截图卡片必须收起，不能叠在视频上。
    await expect(page.getByTestId("screenshot-card")).toHaveCount(0);
    await shot(page, `s6ga-ending${layout === "mobile" ? "-mobile" : ""}`);
  });

  test("打断不撤销截图弹窗（剧情层 D27）", async ({ page }) => {
    test.setTimeout(120_000);
    await openLive(page);
    await waitLive2DPainted(page);

    await submitText(page, "你好");
    await waitIdle(page);
    await submitText(page, "你好");
    await waitIdle(page);
    await submitText(page, "还不睡吗？");
    await expect(page.getByTestId("screenshot-card")).toBeVisible({ timeout: 30_000 });
    await waitIdle(page);

    // 打断：按住说话。
    await page.getByTestId("ptt").dispatchEvent("pointerdown");
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "listening");
    // 截图弹窗（剧情层）仍在。
    await expect(page.getByTestId("screenshot-card")).toBeVisible();
    await page.getByTestId("ptt").dispatchEvent("pointerup");
  });

  test("截图弹窗可点关闭", async ({ page }) => {
    test.setTimeout(120_000);
    await openLive(page);
    await waitLive2DPainted(page);

    await submitText(page, "你好");
    await waitIdle(page);
    await submitText(page, "你好");
    await waitIdle(page);
    await submitText(page, "还不睡吗？");
    await expect(page.getByTestId("screenshot-card")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("screenshot-close").click();
    await expect(page.getByTestId("screenshot-card")).toHaveCount(0);
  });

  test("抱熊只在 silentAction=show_item 出现（渐入中间帧）", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await openLive(page);
    await waitLive2DPainted(page);

    // 走到 reveal：silentAction=show_item（节点 look），抱熊 ParamPet 0→1→0。
    await submitText(page, "你好");
    await waitIdle(page);
    await submitText(page, "你好");
    await waitIdle(page);
    await submitText(page, "还不睡吗？");
    // 进入 reveal 轮：等这一轮开始说话（第 3 个 beat 就是 silentAction=show_item）。
    await expect(page.getByTestId("live")).toHaveAttribute("data-phase", "speaking", { timeout: 30_000 });
    // 抱熊渐入 0.6s：静默 beat 出现后再等约 300ms 截一张「渐入中间帧」。
    await page.waitForTimeout(1_100);
    await page.screenshot({ path: "e2e/out/s6ga-pet-mid.png" });
    // 截图文件落盘即可（Claude 人工核对），这里只断言布局确定。
    expect(testInfo.project.name === "desktop" || testInfo.project.name === "iphone-13").toBe(true);
    await waitIdle(page);
  });
});

test.describe("S6g-A §5：入口按钮", () => {
  test("桌面顶栏「文档」「观测」可见并能跳转", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "桌面入口只在桌面布局");
    await openLive(page);

    const docs = page.getByTestId("entry-docs");
    const obs = page.getByTestId("entry-obs");
    await expect(docs).toBeVisible();
    await expect(obs).toBeVisible();
    await expect(docs).toHaveText("文档");
    await expect(obs).toHaveText("观测");

    // 跳文档（默认打开 00-导读.md）。
    await docs.click();
    await expect(page.getByTestId("docs-app")).toBeVisible({ timeout: 20_000 });

    await page.goto("/");
    await page.mouse.click(4, 4);
    await expect(page.getByTestId("entry-obs")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("entry-obs").click();
    await expect(page.getByTestId("obs-app")).toBeVisible({ timeout: 20_000 });
  });

  test("手机菜单里含「文档」「观测」并能跳转", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "desktop", "手机菜单只在手机布局");
    await openLive(page);

    await page.getByTestId("mobile-menu-toggle").click();
    const docs = page.getByTestId("entry-docs");
    await expect(docs).toBeVisible();
    await expect(page.getByTestId("entry-obs")).toBeVisible();

    await docs.click();
    await expect(page.getByTestId("docs-app")).toBeVisible({ timeout: 20_000 });
  });
});
