import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * §4.1 / freeze-fix9 §1：逐参数实测探针（**开发工具，不列入 §8 验收集**）。
 *
 * freeze-fix1 的探针只取**一次基准帧**、没有对照噪声，结论作废。本版：
 * 1. **噪声对照**：默认参数下连续取两帧，在**右臂区域**内算「静止噪声」差异；
 * 2. 参数 min / max 各取两帧，与默认帧比较（取差异较大的那一帧）；
 * 3. 只统计**右臂区域**：人物包围盒右半、纵向 32%–78%（肩到腰，避开头部眨眼/抖动的干扰）；
 * 4. 「有效」= 区域差异 **≥ 噪声 + 5 个百分点**（即真的比静止抖动更明显）。
 * 另测「挥手组合」（大臂 + 小臂 + 手 + 手转动）。
 *
 * 手工运行：`PROBE=1 pnpm e2e -- e2e/param-probe.spec.ts --project=desktop`
 * 结果写 `e2e/out/param-probe/table.json`（不打开图片，只做像素统计）。
 */

const PARAMS: ReadonlyArray<{ id: string; min: number; max: number }> = [
  { id: "ParamBoomR", min: -1, max: 1 },
  { id: "ParamForeamR", min: -1, max: 1 },
  { id: "ParamHandR", min: -1, max: 1 },
  { id: "ParamHandTurnR", min: -1, max: 1 },
  { id: "ParamHandHoldR", min: 0, max: 1 },
  { id: "ParamTailX1", min: -1, max: 1 },
  { id: "ParamTailX2", min: -1, max: 1 },
  { id: "ParamTailX3", min: -1, max: 1 },
  { id: "ParamEarsLY2", min: -1, max: 1 },
  { id: "ParamEarsRY2", min: -1, max: 1 },
];

const WAVE_COMBO: Record<string, number> = {
  ParamBoomR: 0.9,
  ParamForeamR: 0.9,
  ParamHandR: 0.95,
  ParamHandTurnR: 0.6,
};

type Rect = { x0: number; y0: number; x1: number; y1: number };

/**
 * 一次读回：先算人物包围盒，再按「右臂区域」只读该区域像素（stride 采样加速）。
 * 返回区域像素（alpha>16 视为不透明）与区域几何。
 */
async function grabArm(page: Page): Promise<{ w: number; data: number[]; rect: Rect; centroid: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="yuna-canvas"]');
    const gl = canvas?.getContext("webgl");
    if (!canvas || !gl) return { w: 0, data: [], rect: { x0: 0, y0: 0, x1: 0, y1: 0 }, centroid: 0 };
    const W = canvas.width;
    const H = canvas.height;
    const all = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, all);

    // 包围盒。
    let bx0 = W;
    let bx1 = -1;
    let by0 = H;
    let by1 = -1;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        if ((all[(y * W + x) * 4 + 3] ?? 0) > 16) {
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
      }
    }
    if (bx1 < 0) return { w: 0, data: [], rect: { x0: 0, y0: 0, x1: 0, y1: 0 }, centroid: 0 };

    // 右臂区域：右半、纵向 32%–78%（避开头顶与腿）。
    const midX = Math.floor((bx0 + bx1) / 2);
    const h = by1 - by0;
    const rect = {
      x0: midX,
      y0: Math.floor(by0 + h * 0.32),
      x1: bx1,
      y1: Math.floor(by0 + h * 0.78),
    };

    const stride = 2;
    const data: number[] = [];
    let sumY = 0;
    let count = 0;
    for (let y = rect.y0; y < rect.y1; y += stride) {
      for (let x = rect.x0; x < rect.x1; x += stride) {
        const i = (y * W + x) * 4;
        data.push(all[i] ?? 0, all[i + 1] ?? 0, all[i + 2] ?? 0, all[i + 3] ?? 0);
        if ((all[i + 3] ?? 0) > 16) {
          sumY += y - rect.y0;
          count += 1;
        }
      }
    }
    const rows = Math.ceil((rect.y1 - rect.y0) / stride);
    return { w: Math.ceil((rect.x1 - rect.x0) / stride), data, rect, centroid: count === 0 ? 0 : sumY / count / Math.max(1, rect.y1 - rect.y0) };
  });
}

/** 两个区域像素快照的差异比例（0–1，逐像素 RGBA 容差 8）。 */
function diff(a: { data: number[] }, b: { data: number[] }): number {
  let total = 0;
  let changed = 0;
  const n = Math.min(a.data.length, b.data.length);
  for (let i = 0; i < n; i += 4) {
    const aA = a.data[i + 3] ?? 0;
    const bA = b.data[i + 3] ?? 0;
    if (aA <= 16 && bA <= 16) continue;
    total += 1;
    if (
      Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) > 8 ||
      Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) > 8 ||
      Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0)) > 8 ||
      Math.abs(aA - bA) > 8
    ) {
      changed += 1;
    }
  }
  return total === 0 ? 0 : changed / total;
}

/** 整画布像素快照（用于定位参数影响区域）。 */
async function grabFull(page: Page): Promise<{ w: number; h: number; data: number[] }> {
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

/** 变化像素数量与包围盒（Y 从上到下；OpenGL readPixels 的 y=0 在底部，这里换算成屏幕坐标）。 */
function changedBBox(
  a: { w: number; h: number; data: number[] },
  b: { w: number; h: number; data: number[] },
): { count: number; x0: number; x1: number; y0: number; y1: number } {
  let x0 = a.w;
  let x1 = -1;
  let y0 = a.h;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < a.h; y += 1) {
    for (let x = 0; x < a.w; x += 1) {
      const i = (y * a.w + x) * 4;
      if (
        Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) > 8 ||
        Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) > 8 ||
        Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0)) > 8 ||
        Math.abs((a.data[i + 3] ?? 0) - (b.data[i + 3] ?? 0)) > 8
      ) {
        count += 1;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        // 转屏幕坐标：屏幕 y = h - 1 - glY。
        const screenY = a.h - 1 - y;
        if (screenY < y0) y0 = screenY;
        if (screenY > y1) y1 = screenY;
      }
    }
  }
  return { count, x0, x1, y0, y1 };
}

/** 变化像素的粗网格热力图（cols×rows，字符 0-9 表示相对密度）；屏幕坐标（y 从上到下）。 */
function changeGrid(
  a: { w: number; h: number; data: number[] },
  b: { w: number; h: number; data: number[] },
  cols: number,
  rows: number,
): string[] {
  const counts = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  let max = 0;
  for (let y = 0; y < a.h; y += 1) {
    for (let x = 0; x < a.w; x += 1) {
      const i = (y * a.w + x) * 4;
      if (
        Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) > 8 ||
        Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) > 8 ||
        Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0)) > 8 ||
        Math.abs((a.data[i + 3] ?? 0) - (b.data[i + 3] ?? 0)) > 8
      ) {
        const screenY = a.h - 1 - y;
        const gx = Math.min(cols - 1, Math.floor((x / a.w) * cols));
        const gy = Math.min(rows - 1, Math.floor((screenY / a.h) * rows));
        (counts[gy] as number[])[gx] = ((counts[gy] as number[])[gx] ?? 0) + 1;
        if ((counts[gy] as number[])[gx]! > max) max = (counts[gy] as number[])[gx]!;
      }
    }
  }
  return counts.map((row) =>
    row.map((n) => (n === 0 ? "." : String(Math.min(9, Math.round((n / Math.max(1, max)) * 9))))).join(""),
  );
}

async function setProbe(page: Page, params: Record<string, number> | null): Promise<void> {
  await page.evaluate((p) => window.__setProbeCombo?.(p), params);
  await page.waitForTimeout(450);
}
/** 冻结 / 解冻动画帧（freeze-fix9 §1：消除呼吸 / 眨眼噪声，保证差异只来自参数）。 */
async function freeze(page: Page, tSec: number | null): Promise<void> {
  await page.evaluate((t) => window.__freezeFrame?.(t), tSec);
}

async function twoFrames(page: Page): Promise<[{ data: number[]; centroid: number }, { data: number[]; centroid: number }]> {
  const f1 = await grabArm(page);
  await page.waitForTimeout(250);
  const f2 = await grabArm(page);
  return [f1, f2];
}

test.describe("§4.1 参数探针（开发工具，带噪声对照）", () => {
  test.skip(process.env.PROBE !== "1", "开发探针：需要 PROBE=1 才运行");
  test.describe.configure({ timeout: 600_000 });

  test("带噪声对照的右臂区域实测表", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "探针只在桌面项目跑");

    mkdirSync("e2e/out/param-probe", { recursive: true });
    const tablePath = "e2e/out/param-probe/table.json";

    await page.goto("?preview=yuna");
    await expect(page.getByTestId("yuna-canvas")).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(() => window.__probeReady === true, undefined, { timeout: 20_000 });
    await page.waitForTimeout(1_500);

    // ① 静止噪声（真实动画）：默认参数下同一时刻连续两帧的差异。
    await setProbe(page, null);
    const [nA, nB] = await twoFrames(page);
    const noise = diff(nA, nB);

    // ② 冻结帧后再测参数：消除呼吸 / 眨眼，差异只来自参数本身。
    await freeze(page, 0);
    await setProbe(page, null);
    await page.waitForTimeout(400);
    const base = await grabArm(page);
    const baseCentroid = base.centroid;

    const rows: Array<Record<string, number | string | boolean>> = [];
    const flush = (): void =>
      writeFileSync(
        tablePath,
        JSON.stringify({ noiseReal: pct(noise), frozen: true, centroidBase: round(baseCentroid), rows }, null, 2),
      );

    const measure = async (params: Record<string, number>): Promise<{ ratio: number; centroid: number }> => {
      await setProbe(page, params);
      await page.waitForTimeout(400);
      const f = await grabArm(page);
      return { ratio: diff(base, f), centroid: f.centroid - baseCentroid };
    };

    for (const { id, min, max } of PARAMS) {
      const row: Record<string, number | string | boolean> = {
        param: id,
        noise: pct(noise),
        min: 0,
        max: 0,
        minCentroid: 0,
        maxCentroid: 0,
        effective: false,
      };
      const lo = await measure({ [id]: min });
      const hi = await measure({ [id]: max });
      row.min = pct(lo.ratio);
      row.max = pct(hi.ratio);
      row.minCentroid = round(lo.centroid);
      row.maxCentroid = round(hi.centroid);
      row.effective = Math.max(row.min as number, row.max as number) >= pct(noise) + 5;
      rows.push(row);
      flush();
      // eslint-disable-next-line no-console
      console.log(`probe ${id}: noise=${row.noise}% min=${row.min}% max=${row.max}% eff=${row.effective}`);
    }

    // 挥手组合。
    const combo = await measure(WAVE_COMBO);
    const comboRow: Record<string, number | string | boolean> = {
      param: "WAVE_COMBO",
      noise: pct(noise),
      min: pct(combo.ratio),
      max: pct(combo.ratio),
      minCentroid: round(combo.centroid),
      maxCentroid: round(combo.centroid),
      effective: pct(combo.ratio) >= pct(noise) + 5,
    };
    rows.push(comboRow);
    flush();

    // 复位。
    await setProbe(page, null);
    await freeze(page, null);
    // eslint-disable-next-line no-console
    console.table(rows);
  });

  test("freeze-fix9 §1：变化像素定位（判断哪个参数真正移动右臂）", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "探针只在桌面项目跑");
    mkdirSync("e2e/out/param-probe", { recursive: true });

    await page.goto("?preview=yuna");
    await expect(page.getByTestId("yuna-canvas")).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(() => window.__probeReady === true, undefined, { timeout: 20_000 });
    await page.waitForTimeout(1_500);
    await freeze(page, 0);
    await setProbe(page, null);
    await page.waitForTimeout(400);

    const base = await grabFull(page);
    const rows: Array<Record<string, number | string>> = [];
    for (const probe of [
      { name: "ParamBoomR(max)", params: { ParamBoomR: 1 } },
      { name: "ParamForeamR(max)", params: { ParamForeamR: 1 } },
      { name: "ParamHandR(max)", params: { ParamHandR: 1 } },
      { name: "ParamHandTurnR(max)", params: { ParamHandTurnR: 1 } },
      { name: "WAVE_COMBO", params: WAVE_COMBO },
      { name: "ParamTailX1(max)", params: { ParamTailX1: 1 } },
      { name: "ParamEarsRY2(max)", params: { ParamEarsRY2: 1 } },
    ]) {
      await setProbe(page, probe.params);
      await page.waitForTimeout(400);
      const cur = await grabFull(page);
      const box = changedBBox(base, cur);
      const grid = changeGrid(base, cur, 12, 8);
      rows.push({
        参数: probe.name,
        变化像素: box.count,
        包围盒: `x[${box.x0}-${box.x1}] y[${box.y0}-${box.y1}]`,
        画布: `${base.w}x${base.h}`,
        grid: grid.join(" "),
      });
      // eslint-disable-next-line no-console
      console.log(`${probe.name}: changed=${box.count} bbox=x[${box.x0}-${box.x1}] y[${box.y0}-${box.y1}]`);
      // eslint-disable-next-line no-console
      console.log(`  grid(${grid[0]?.length ?? 0} cols):\n${grid.join("\n")}`);
    }
    await setProbe(page, null);
    await freeze(page, null);
    writeFileSync("e2e/out/param-probe/change-bbox.json", JSON.stringify(rows, null, 2));
    // eslint-disable-next-line no-console
    console.table(rows);
  });

  test("freeze-fix9 §1：右臂是否抬起（臂区竖直重心 / 顶边）", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "探针只在桌面项目跑");
    mkdirSync("e2e/out/param-probe", { recursive: true });

    await page.goto("?preview=yuna");
    await expect(page.getByTestId("yuna-canvas")).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(() => window.__probeReady === true, undefined, { timeout: 20_000 });
    await page.waitForTimeout(1_500);
    await freeze(page, 0);
    await setProbe(page, null);
    await page.waitForTimeout(400);

    const base = await grabFull(page);

    // 臂区：x∈[430,700]（热力图列 4–6），y∈[200,560]（行 2–5）。
    const ARM = { x0: 430, x1: 700, y0: 200, y1: 560 };
    const stat = (p: { w: number; h: number; data: number[] }, r: typeof ARM): { centroid: number; top: number; count: number } => {
      let sum = 0;
      let count = 0;
      let top = r.y1;
      for (let sy = r.y0; sy < r.y1; sy += 1) {
        const gy = p.h - 1 - sy;
        for (let x = r.x0; x < r.x1; x += 1) {
          if ((p.data[(gy * p.w + x) * 4 + 3] ?? 0) > 16) {
            sum += sy;
            count += 1;
            if (sy < top) top = sy;
          }
        }
      }
      return { centroid: count === 0 ? 0 : sum / count, top, count };
    };

    const results: Array<Record<string, number | string>> = [];
    const measure = async (name: string, params: Record<string, number> | null): Promise<void> => {
      await setProbe(page, params);
      await page.waitForTimeout(450);
      const p = await grabFull(page);
      const s = stat(p, ARM);
      results.push({
        参数: name,
        臂区重心y: round(s.centroid),
        臂区顶边y: round(s.top),
        不透明像素: s.count,
        重心变化: round(s.centroid - stat(base, ARM).centroid),
        顶边变化: round(s.top - stat(base, ARM).top),
      });
      // eslint-disable-next-line no-console
      console.log(`${name}: centroid=${round(s.centroid)} top=${round(s.top)} count=${s.count}`);
    };
    await measure("default", null);
    await measure("BoomR(max)", { ParamBoomR: 1 });
    await measure("BoomR(min)", { ParamBoomR: -1 });
    await measure("ForeamR(max)", { ParamForeamR: 1 });
    await measure("ForeamR(min)", { ParamForeamR: -1 });
    await measure("HandR(max)", { ParamHandR: 1 });
    await measure("HandR(min)", { ParamHandR: -1 });
    await measure("WAVE_COMBO", WAVE_COMBO);

    await setProbe(page, null);
    await freeze(page, null);
    writeFileSync("e2e/out/param-probe/arm-raise.json", JSON.stringify({ ARM, results }, null, 2));
    // eslint-disable-next-line no-console
    console.table(results);
  });
});

function pct(value: number): number {
  return Number((value * 100).toFixed(2));
}
function round(value: number): number {
  return Number(value.toFixed(4));
}
