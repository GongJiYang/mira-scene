/**
 * 规则文件 / 配色文件的解析与校验（S6e §0 契约：「配色规则文件非法 → 报错退出」）。
 *
 * 不引第三方 schema 库：手写校验足够且让「非法输入」的错误信息清晰（YAGNI）。
 */
import type { ClothingRules, HueRule, Palette } from "./pure.js";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 校验并解析衣服 part 匹配规则。 */
export function parseRules(json: unknown): ParseResult<ClothingRules> {
  if (!isRecord(json)) return { ok: false, error: "rules.json 顶层必须是对象" };
  const include = json.include;
  const exclude = json.exclude;
  if (!isStringArray(include)) return { ok: false, error: "rules.json 缺少字符串数组字段 include" };
  if (!isStringArray(exclude)) return { ok: false, error: "rules.json 缺少字符串数组字段 exclude" };
  if (include.length === 0) return { ok: false, error: "rules.json 的 include 不能为空" };
  return { ok: true, value: { include, exclude } };
}

/** 校验并解析配色文件；每个变体的每条规则都要合法。 */
export function parsePalettes(json: unknown): ParseResult<Palette[]> {
  const list = isRecord(json) && Array.isArray(json.palettes) ? json.palettes : undefined;
  if (list === undefined) return { ok: false, error: "palettes.json 缺少数组字段 palettes" };
  if (list.length === 0) return { ok: false, error: "palettes.json 的 palettes 不能为空" };

  const palettes: Palette[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    const where = `palettes[${i}]`;
    if (!isRecord(entry)) return { ok: false, error: `${where} 必须是对象` };
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      return { ok: false, error: `${where}.name 必须是非空字符串` };
    }
    if (!Array.isArray(entry.rules) || entry.rules.length === 0) {
      return { ok: false, error: `${where}.rules 必须是非空数组` };
    }
    const rules: HueRule[] = [];
    for (let j = 0; j < entry.rules.length; j += 1) {
      const parsed = parseHueRule(entry.rules[j], `${where}.rules[${j}]`);
      if (!parsed.ok) return parsed;
      rules.push(parsed.value);
    }
    palettes.push({ name: entry.name, rules });
  }

  const names = new Set<string>();
  for (const palette of palettes) {
    if (names.has(palette.name)) return { ok: false, error: `变体名重复：${palette.name}` };
    names.add(palette.name);
  }
  return { ok: true, value: palettes };
}

function parseHueRule(raw: unknown, where: string): ParseResult<HueRule> {
  if (!isRecord(raw)) return { ok: false, error: `${where} 必须是对象` };
  const from = num(raw.from);
  const to = num(raw.to);
  const target = num(raw.target);
  const saturation = num(raw.saturation);
  const lightnessShift = num(raw.lightnessShift);
  const minSaturation = raw.minSaturation === undefined ? 0.15 : num(raw.minSaturation);

  if (from === undefined) return { ok: false, error: `${where}.from 必须是数字` };
  if (to === undefined) return { ok: false, error: `${where}.to 必须是数字` };
  if (target === undefined) return { ok: false, error: `${where}.target 必须是数字` };
  if (saturation === undefined) return { ok: false, error: `${where}.saturation 必须是数字` };
  if (lightnessShift === undefined) return { ok: false, error: `${where}.lightnessShift 必须是数字` };
  if (minSaturation === undefined) return { ok: false, error: `${where}.minSaturation 必须是数字` };
  if (from < 0 || from > 360 || to < 0 || to > 360) {
    return { ok: false, error: `${where} 的色相区间必须在 0–360 之间` };
  }
  if (from === to) return { ok: false, error: `${where} 的色相区间不能为空（from === to）` };
  if (saturation < 0 || saturation > 1) return { ok: false, error: `${where}.saturation 必须在 0–1 之间` };
  if (minSaturation < 0 || minSaturation > 1) {
    return { ok: false, error: `${where}.minSaturation 必须在 0–1 之间` };
  }
  if (Math.abs(lightnessShift) > 0.05 + 1e-9) {
    return { ok: false, error: `${where}.lightnessShift 超出 ±0.05（§2 要求）` };
  }
  return { ok: true, value: { from, to, target, saturation, lightnessShift, minSaturation } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
