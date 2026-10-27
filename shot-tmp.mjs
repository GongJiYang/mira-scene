import { chromium } from "@playwright/test";

const browser = await chromium.launch();

async function shot(name, viewport, query = "", actions) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://localhost:5273/${query}`, { waitUntil: "networkidle" });
  await page.mouse.click(4, 4);
  await page.waitForTimeout(2500);
  if (actions) await actions(page);
  await page.screenshot({ path: `/tmp/yuna-media/${name}.png` });
  console.log(name, "errors:", errors.slice(0, 5));
  await page.close();
}

await shot("live-desktop", { width: 1440, height: 900 });
await shot("live-mobile", { width: 390, height: 844 }, "", async (page) => {
  await page.waitForTimeout(800);
});
await shot("live-yuna-desktop", { width: 1440, height: 900 }, "", async (page) => {
  await page.getByTestId("channel-yuna").click();
  await page.waitForTimeout(3000);
});
await browser.close();
