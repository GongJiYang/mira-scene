import { expect, test, type Page } from "@playwright/test";

/**
 * S6d §4：开发文档窗口端到端。
 *
 * 入口是独立路由 `?docs=1`，不依赖直播间 UI、不连服务端（文档是构建时静态数据）。
 * 覆盖：打开、点目录切换文档、搜索 `D39` 能命中、桌面与手机截图。
 */

async function openDocs(page: Page): Promise<void> {
  await page.goto("/?docs=1");
  await expect(page.getByTestId("docs-app")).toBeVisible();
  await expect(page.getByTestId("docs-article")).toBeVisible();
}

test("桌面：打开文档、点目录、搜索 D39 命中", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "桌面布局用例只在 desktop 项目跑");

  await openDocs(page);

  // 默认渲染第一篇文档的正文（非空）。
  await expect(page.getByTestId("docs-article")).not.toBeEmpty();

  // 目录树渲染了白名单文档。
  const tree = page.getByTestId("docs-tree");
  await expect(tree).toBeVisible();
  expect(await page.getByTestId("docs-tree-item").count()).toBeGreaterThan(0);

  // 点「报告与记录」分组里的一个文档（s6a-report）→ 正文切换。
  const reportItem = page.locator('[data-testid="docs-tree-item"][data-path="docs/tasks/s6a-report.md"]');
  await reportItem.click();
  await expect(reportItem).toHaveAttribute("data-active", "1");
  await expect(page.getByTestId("docs-article")).toContainText("S6a 执行报告");

  // 右侧大纲列出本文标题。
  expect(await page.getByTestId("docs-toc-item").count()).toBeGreaterThan(0);

  // 带锚点的分享链接也应生效（不报错）。
  await page.goto("/?docs=1&doc=docs/architecture/decisions.md#d39");
  await expect(page.getByTestId("docs-article")).toContainText("架构决策记录");

  // 搜索 D39。
  const input = page.getByTestId("docs-search-input");
  await input.fill("D39");
  await input.press("Enter");
  await expect(page.getByTestId("docs-results")).toBeVisible();
  const results = page.getByTestId("docs-result-item");
  expect(await results.count()).toBeGreaterThan(0);

  // 至少有一篇命中文档包含 D39（decisions 里就有）。
  const firstPath = await results.first().getAttribute("data-path");
  expect(firstPath).not.toBeNull();

  // 点第一条结果 → 跳到该文档正文。
  await results.first().click();
  await expect(page.getByTestId("docs-article")).toBeVisible();

  await page.screenshot({ path: "e2e/out/docs-desktop.png", fullPage: false });
});

test("手机：目录收进抽屉，正文全宽", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "iphone-13", "手机布局用例只在 iphone-13 项目跑");

  await openDocs(page);

  // 抽屉默认收起（目录不可见）。
  await expect(page.getByTestId("docs-tree")).toBeHidden();
  await expect(page.getByTestId("docs-article")).toBeVisible();

  // 点 ☰ 打开抽屉。
  await page.getByTestId("docs-drawer-toggle").click();
  await expect(page.getByTestId("docs-tree")).toBeVisible();

  // 点一个文档 → 抽屉自动收起、正文切换。
  const item = page.getByTestId("docs-tree-item").first();
  const targetPath = await item.getAttribute("data-path");
  await item.click();
  await expect(page.getByTestId("docs-tree")).toBeHidden();
  await expect(page.getByTestId("docs-article")).toBeVisible();

  // URL 记住了当前文档。
  const docParam = await page.evaluate(() => new URLSearchParams(window.location.search).get("doc"));
  expect(docParam).toBe(targetPath);

  // 无横向滚动。
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);

  await page.screenshot({ path: "e2e/out/docs-mobile.png", fullPage: false });
});

test("契约：不渲染原始 HTML、目录只含白名单文档", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "契约用例只在 desktop 项目跑一次");

  await openDocs(page);

  // §0 契约：Markdown 里的原始 HTML 不得变成 DOM（防注入）。
  // 用一篇含 `<script>` 字面量的文档验证：它只作为纯文本出现，不会生成 script 元素。
  await page.goto("/?docs=1&doc=docs/tasks/s6a-report.md");
  await expect(page.getByTestId("docs-article")).toContainText("S6a 执行报告");

  const injected = await page.evaluate(() => ({
    scripts: document.querySelectorAll('[data-testid="docs-article"] script').length,
    iframes: document.querySelectorAll('[data-testid="docs-article"] iframe').length,
    // 文档里出现的 `<script>` 字面量应被转义成文本（存在于 textContent）。
    hasLiteral: (document.querySelector('[data-testid="docs-article"]')?.textContent ?? "").includes("<script>"),
  }));
  expect(injected.scripts).toBe(0);
  expect(injected.iframes).toBe(0);
  expect(injected.hasLiteral).toBe(true);

  // §1 白名单：目录里不得出现任务说明、日志、隐藏文件。
  const paths = await page
    .locator('[data-testid="docs-tree-item"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-path") ?? ""));
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    expect(path.endsWith(".log")).toBe(false);
    expect(path).not.toContain("/.");
    expect(path.startsWith("docs/tasks/") ? path.endsWith("-report.md") : true).toBe(true);
  }
  // 任务说明本身不收录。
  expect(paths).not.toContain("docs/tasks/s6d-docs.md");
});
