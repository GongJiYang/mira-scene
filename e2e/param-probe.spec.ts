import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * §4.1：逐参数实测探针（**开发工具，不列入 §8 验收集**）。
 *
 * 手工运行：`pnpm e2e -- e2e/param-probe.spec.ts --project=desktop`
 *
 * 对每个参数在 min / max 下把预览页的单参数强制置值，用 readPixels 统计不透明像素，
 * 与默认帧比较得到**像素差百分比**；截图写到 `e2e/out/param-probe/<id>-<min|max>.png`（不打开），
 * 汇总表写到 `e2e/out/param-probe/table.json` 并 `console.table` 打印。
 */

/** 目标参数与 min / max 取值（模型参数范围）。 */
const PARAMS: ReadonlyArray<{ id: string; min: number; max: number }> = [
  { id: "ParamLove", min: 0, max: 1 },
  { id: "ParamBlack", min: 0, max: 1 },
  { id: "ParamDark", min: 0, max: 1 },
  { id: "ParamCry", min: 0, max: 1 },
  { id: "ParamTearL", min: 0, max: 1 },
  { id: "ParamTearLY", min: 0, max: 2 },
  { id: "ParamTearAppearL", min: 0, max: 1 },
  { id: "ParamTearR", min: 0, max: 1 },
  { id: "ParamTearRY", min: 0, max: 2 },
  { id: "ParamTearAppearR", min: 0, max: 1 },
  { id: "ParamHandR", min: -1, max: 1 },
  { id: "ParamHandL", min: -1, max: 1 },
  { id: "ParamHandTurnR", min: -1, max: 1 },
  { id: "ParamHandHoldR", min: 0, max: 1 },
  { id: "ParamBoomR", min: -1, max: 1 },
  { id: "ParamForeamR", min: -1, max: 1 },
  { id: "ParamBoomL", min: -1, max: 1 },
  { id: "ParamForeamL", min: -1, max: 1 },
  { id: "ParamTailX1", min: -1, max: 1 },
  { id: "ParamTailX2", min: -1, max: 1 },
  { id: "ParamTailX3", min: -1, max: 1 },
  { id: "ParamEarsLY2", min: -1, max: 1 },
  { id: "ParamEarsRY2", min: -1, max: 1 },
  { id: "ParamFlyHead", min: 0, max: 1 },
  { id: "ParamAngry", min: 0, max: 1 },
  { id: "ParamShy", min: 0, max: 1 },
  { id: "ParamHeart", min: 0, max: 1 },
];

/** 采集画布像素：返回「不透明像素的 RGBA 快照」（长度 = canvasW*canvasH*4）。 */
async function grabPixels(page: Page): Promise<{ w: number; h: number; data: number[] }> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="yuna-canvas"]');
    const gl = canvas?.getContext("webgl");
    if (!canvas || !gl) return { w: 0, h: 0, data: [] };
    const w = canvas.width;
    const h = canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { w, h, data: Array.from(pixels) };
  });
}

/** 与基线比较：不透明像素里 RGBA 不同的比例（0–1）。 */
function diffRatio(base: { data: number[] }, other: { data: number[] }): number {
  if (base.data.length === 0 || other.data.length === 0) return 0;
  let opaque = 0;
  let diff = 0;
  for (let i = 0; i < base.data.length; i += 4) {
    const baseAlpha = base.data[i + 3] ?? 0;
    const otherAlpha = other.data[i + 3] ?? 0;
    if (baseAlpha <= 16 && otherAlpha <= 16) continue;
    opaque += 1;
    if (
      Math.abs((base.data[i] ?? 0) - (other.data[i] ?? 0)) > 8 ||
      Math.abs((base.data[i + 1] ?? 0) - (other.data[i + 1] ?? 0)) > 8 ||
      Math.abs((base.data[i + 2] ?? 0) - (other.data[i + 2] ?? 0)) > 8 ||
      Math.abs(baseAlpha - otherAlpha) > 8
    ) {
      diff += 1;
    }
  }
  return opaque === 0 ? 0 : diff / opaque;
}

/** 设置探针（运行时，无需重载模型）并等待若干帧稳定。 */
async function applyProbe(page: Page, param: string | null, value: number | null): Promise<void> {
  await page.evaluate(
    ([p, v]) => {
      window.__setProbe?.(p as string | null, v as number);
    },
    [param, value],
  );
  // 等若干帧（呼吸 / 物理稳定）。帧率 60fps → 500ms 足够覆盖若干帧。
  await page.waitForTimeout(500);
}

test.describe("§4.1 参数探针（开发工具）", () => {
  // 开发工具：**默认跳过**，只在显式 `PROBE=1` 时运行（避免污染常规 e2e）。
  // 运行：`PROBE=1 pnpm e2e -- e2e/param-probe.spec.ts --project=desktop`
  test.skip(process.env.PROBE !== "1", "开发探针：需要 PROBE=1 才运行");
  // 逐参数跑完较慢，放宽测试超时。
  test.describe.configure({ timeout: 600_000 });
  test("逐参数 min/max 像素差表 + 截图", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "探针只在桌面项目跑");

    mkdirSync("e2e/out/param-probe", { recursive: true });

    // 只加载一次模型；之后用 window.__setProbe 运行时改参数。
    await page.goto("?preview=yuna");
    await expect(page.getByTestId("yuna-canvas")).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(() => window.__probeReady === true, undefined, { timeout: 20_000 });
    await page.waitForTimeout(1_500);

    const tablePath = "e2e/out/param-probe/table.json";
    const flush = (rows: Array<{ param: string; min: number; max: number }>): void => {
      writeFileSync(tablePath, JSON.stringify(rows, null, 2));
    };

    // 基线：默认帧（无探针）。
    await applyProbe(page, null, null);
    await page.waitForTimeout(500);
    const baseline = await grabPixels(page);

    // PROBE_ONLY=ParamBoomR,ParamForeamR → 只跑指定参数（快速验证用）。
    const only = (process.env.PROBE_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const targets = only.length > 0 ? PARAMS.filter((p) => only.includes(p.id)) : PARAMS;
    // PROBE_SCREENSHOTS=1 时才导出截图（画布持续动画导致截图很慢；默认只出像素差表）。
    const wantShots = process.env.PROBE_SCREENSHOTS === "1";
    if (wantShots) {
      await page.getByTestId("yuna-canvas").screenshot({ path: "e2e/out/param-probe/_baseline.png", timeout: 15_000 }).catch(() => undefined);
    }

    const rows: Array<{ param: string; min: number; max: number }> = [];
    for (const { id, min, max } of targets) {
      const row: { param: string; min: number; max: number } = { param: id, min: 0, max: 0 };
      for (const [label, value] of [
        ["min", min],
        ["max", max],
      ] as const) {
        await applyProbe(page, id, value);
        const pixels = await grabPixels(page);
        if (wantShots) {
          await page
            .getByTestId("yuna-canvas")
            .screenshot({ path: `e2e/out/param-probe/${id}-${label}.png`, timeout: 15_000 })
            .catch(() => undefined);
        }
        row[label] = Number((diffRatio(baseline, pixels) * 100).toFixed(2));
      }
      rows.push(row);
      // 每个参数跑完就落盘，避免中途超时丢失结果。
      flush(rows);
      // eslint-disable-next-line no-console
      console.log(`probe ${id}: min=${row.min}% max=${row.max}%`);
    }

    // 复位探针。
    await applyProbe(page, null, null);

    flush(rows);
    // eslint-disable-next-line no-console
    console.table(rows);
  });
});
