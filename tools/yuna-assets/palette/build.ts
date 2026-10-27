#!/usr/bin/env -S tsx
/**
 * CLI 入口（S6e §3）：`tsx tools/yuna-assets/palette/build.ts [--palette sakura] [--list]`
 *
 * - 缺省构建全部变体；`--palette <name>` 只构建一个。
 * - `--list` 只打印 part 匹配清单（供审核），不写文件。
 */
import { run } from "./src/build.js";
import { analyze, PALETTE_DIR, readJson } from "./src/cli.js";
import { parseRules } from "./src/schema.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes("--list");
  const paletteIndex = argv.indexOf("--palette");
  const paletteName = paletteIndex >= 0 ? argv[paletteIndex + 1] : undefined;

  if (listOnly) {
    const parsed = parseRules(readJson(`${PALETTE_DIR}/rules.json`));
    if (!parsed.ok) throw new Error(`rules.json 非法：${parsed.error}`);
    const analysis = await analyze(parsed.value);
    console.log("part id | 中文名 | 类别 | 直属 drawable 数 | 命中");
    for (const c of analysis.classifications) {
      console.log(
        `${c.partId} | ${c.name} | ${c.category} | ${c.drawableCount} | ${c.matched || "-"}`,
      );
    }
    console.log(`\n衣服 drawable 总数：${analysis.clothingDrawableIndices.length}`);
    return;
  }

  const results = await run(paletteName ? { paletteName } : {});
  for (const result of results) {
    const total = result.files.reduce((sum, f) => sum + f.bytes, 0);
    console.log(`变体 ${result.name}：${result.files.length} 张贴图，共 ${total} 字节，改动像素 ${result.changedPixels}`);
    for (const file of result.files) {
      console.log(`  ${file.path} (${file.bytes} 字节)`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
