import type { P3Entry } from "./probe";

export type BlindItem = {
  model: string;
  emotion: string;
};

/** 可复现的伪随机（mulberry32），让同一份结果每次生成的顺序一致。 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const random = seededRandom(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = copy[i] as T;
    const b = copy[j] as T;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

const PAGE = (items: readonly BlindItem[], emotions: readonly string[], seed: number): string => {
  const payload = items.map((item) => ({
    f: `${item.model}/${item.emotion}.mp3`,
    // 只做混淆，不加密：盲听页是本地一次性工具。
    k: Buffer.from(`${item.model}|${item.emotion}`).toString("base64"),
  }));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>P3 情绪盲听</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; font: 15px/1.6 -apple-system, "PingFang SC", sans-serif; background: #14161a; color: #e8e8ea; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p.hint { color: #9aa0a6; margin: 0 0 20px; }
  ol { padding-left: 20px; }
  li { margin: 0 0 14px; padding: 10px 12px; background: #1c1f26; border-radius: 8px; }
  audio { vertical-align: middle; height: 34px; }
  select { margin-left: 8px; padding: 4px 8px; background: #262a33; color: #e8e8ea; border: 1px solid #3a3f4b; border-radius: 6px; }
  button { margin-top: 8px; padding: 8px 16px; background: #4a7dff; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  .result { margin-top: 16px; white-space: pre-wrap; font-family: ui-monospace, monospace; }
  .ok { color: #6ee7a8; }
  .bad { color: #ff8f8f; }
</style>
</head>
<body>
<h1>P3 情绪盲听（顺序已打乱）</h1>
<p class="hint">共 ${items.length} 条，逐条播放，选你听到的情绪，全部选完后点提交。答案在本地文件里，不要提前查看。</p>
<ol id="list"></ol>
<button id="submit">提交</button>
<div class="result" id="result"></div>
<script type="application/json" id="data">${JSON.stringify({ seed, emotions, items: payload })}</script>
<script>
  const data = JSON.parse(document.getElementById("data").textContent);
  const list = document.getElementById("list");
  const answers = [];
  data.items.forEach((item, index) => {
    const li = document.createElement("li");
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = item.f;
    const select = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "选择情绪";
    select.appendChild(blank);
    for (const emotion of data.emotions) {
      const option = document.createElement("option");
      option.value = emotion;
      option.textContent = emotion;
      select.appendChild(option);
    }
    select.addEventListener("change", () => { answers[index] = select.value; });
    li.append(document.createTextNode(String(index + 1) + ". "), audio, select);
    list.appendChild(li);
  });
  document.getElementById("submit").addEventListener("click", () => {
    const lines = [];
    let correct = 0;
    let answered = 0;
    const perModel = new Map();
    data.items.forEach((item, index) => {
      const truth = atob(item.k).split("|");
      const model = truth[0];
      const emotion = truth[1];
      const picked = answers[index] || "";
      if (picked !== "") answered += 1;
      const hit = picked === emotion;
      if (hit) correct += 1;
      const bucket = perModel.get(model) || { correct: 0, total: 0 };
      bucket.total += 1;
      if (hit) bucket.correct += 1;
      perModel.set(model, bucket);
      lines.push(
        String(index + 1).padStart(2, " ") + "  " + model + " / " + emotion.padEnd(9, " ") +
        " 你选：" + (picked || "—") + (hit ? "  ✓" : "  ✗")
      );
    });
    const accuracy = data.items.length === 0 ? 0 : correct / data.items.length;
    const modelLines = [...perModel.entries()].map(([model, bucket]) =>
      model + "：" + bucket.correct + "/" + bucket.total + "（" + Math.round((bucket.correct / bucket.total) * 100) + "%）"
    );
    const result = document.getElementById("result");
    result.innerHTML =
      "<strong>总正确率：" + correct + "/" + data.items.length + "（" + Math.round(accuracy * 100) + "%），已作答 " + answered + " 条</strong>\\n" +
      modelLines.join("\\n") + "\\n\\n" +
      lines.map((line) => line.includes("✓") ? '<span class="ok">' + line + "</span>" : '<span class="bad">' + line + "</span>").join("\\n");
  });
</script>
</body>
</html>
`;
};

/** 生成打乱顺序的静态盲听页（只收合成成功的条目）。 */
export function renderBlindPage(entries: readonly P3Entry[], seed: number): string {
  const usable = entries.filter((entry) => entry.ok && entry.bytes > 0);
  const items = shuffle(
    usable.map((entry) => ({ model: entry.model, emotion: entry.emotion })),
    seed,
  );
  return PAGE(items, ["neutral", "calm", "guarded", "sad", "warm", "surprised"], seed);
}
