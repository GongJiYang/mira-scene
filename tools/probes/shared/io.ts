import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROBES_DIR } from "./env";

export const OUT_DIR = join(PROBES_DIR, "out");

/** 文件名用的时间戳：2026-10-26T12-34-56Z。 */
export function stamp(date = new Date()): string {
  return date.toISOString().replace(/\..+$/, "").replace(/:/g, "-");
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}
