/**
 * S6c §2：场景扩写输出的 schema 与解析（纯函数 + zod）。
 *
 * 输出格式见 `characters/<id>/scene.v1.md`：
 * - 接受：一行 JSON，含 location/time/lighting/props/palette/mood/label/note。
 * - 拒绝：`{"accept":false,"label":"","note":"…"}`。
 *
 * 不合法 → `Invalid`；LLM 拒绝 → `Rejected`。
 */
import { z } from "zod";

/** S6c §2：场景描述（扩写成功时）。 */
export const sceneSpecSchema = z.object({
  accept: z.literal(true),
  location: z.string().min(1),
  time: z.string().min(1),
  lighting: z.string().min(1),
  props: z.array(z.string().min(1)).min(2).max(4),
  palette: z.string().min(1),
  mood: z.string().min(1),
  /** 中文场景名（≤6 字），用于状态条与 `scene_notes`。 */
  label: z.string().min(1).max(6),
  /** 中文一句话，忧奈/夏凛可以拿来接话。 */
  note: z.string().min(1),
});

/** S6c §2：扩写拒绝。 */
export const sceneRejectedSchema = z.object({
  accept: z.literal(false),
  label: z.literal(""),
  note: z.string().min(1),
});

export const sceneOutputSchema = z.discriminatedUnion("accept", [sceneSpecSchema, sceneRejectedSchema]);

export type SceneSpec = z.infer<typeof sceneSpecSchema>;
export type SceneRejected = z.infer<typeof sceneRejectedSchema>;
export type SceneOutput = z.infer<typeof sceneOutputSchema>;

/** 解析结果：扩写成功 / LLM 拒绝 / 输出不合法。 */
export type ParseSceneResult =
  | { kind: "spec"; spec: SceneSpec }
  | { kind: "rejected"; note: string }
  | { kind: "invalid"; reason: string };

/** 去掉一行里可能的代码块围栏与首尾空白。 */
function sanitizeLine(raw: string): string {
  let line = raw.trim();
  line = line.replace(/^```[a-zA-Z0-9]*\s*/, "");
  line = line.replace(/```\s*$/, "");
  return line.trim();
}

/**
 * 纯函数：把 LLM 的原始输出（可能带代码块围栏、多行）解析成 SceneSpec / Rejected / Invalid。
 * 不做 I/O，永不抛错。
 */
export function parseSceneSpec(raw: unknown): ParseSceneResult {
  if (typeof raw !== "string") {
    return { kind: "invalid", reason: `输出不是字符串：${typeof raw}` };
  }
  const line = sanitizeLine(raw);
  if (line === "") return { kind: "invalid", reason: "输出为空" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "invalid", reason: `不是合法 JSON：${line.slice(0, 120)}` };
  }

  const result = sceneOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { kind: "invalid", reason: `schema 校验失败：${issue?.path.join(".") ?? "?"} ${issue?.message ?? ""}` };
  }

  if (result.data.accept) return { kind: "spec", spec: result.data };
  return { kind: "rejected", note: result.data.note };
}
