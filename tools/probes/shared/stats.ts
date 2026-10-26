/** 统计与文本度量（无第三方依赖）。 */

/** 线性插值分位数（与 Excel PERCENTILE.INC / numpy 默认一致）。 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? null;
  const pos = ((sorted.length - 1) * p) / 100;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (pos - low);
}

export function round(value: number | null, digits = 1): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 字符级编辑距离（用于中文 CER）。 */
export function editDistance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/** 去掉标点与空白，只比较字，避免标点差异污染 CER。 */
export function normalizeForCer(text: string): string {
  return text.replace(/[\s，。！？、,.!?；;：:"'“”‘’（）()【】[\]<>|]/g, "");
}

export function cer(reference: string, hypothesis: string): number {
  const ref = normalizeForCer(reference);
  const hyp = normalizeForCer(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return editDistance(ref, hyp) / ref.length;
}
