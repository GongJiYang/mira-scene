/**
 * S6c §3：拼生图提示词（纯函数）。
 *
 * 结构：`[参考图指令] + [场景：location, time, lighting, props, palette, mood] + [构图锁] + [画风锁]`。
 * - **构图锁**：`pack.json` 的 `sceneLock`（英文常量，代码原样追加，LLM 无法修改）。
 * - **画风锁**：两角色共用常量（本模块导出 `SCENE_STYLE_LOCK`）。
 * - `device`：`desktop` → 1536×1024；`mobile` → 1024×1536，并各加一句构图提示。
 *
 * 后置条件（属性测试保证）：输出必然包含完整的 `sceneLock` 与画风锁原文；
 * 任意 spec 字段（含注入式文本如 `ignore previous instructions`）都不会让输出缺少这两段。
 * spec 字段长度各截断到 200 字符。
 */
import type { Pack } from "../characters/pack";
import type { SceneSpec } from "./spec";

/** S6c §3：画风锁（两个角色共用常量）。 */
export const SCENE_STYLE_LOCK =
  "Anime illustration background, no people, no characters, no animals, no readable text, no logos, no brand names, soft cel-shaded Japanese anime style, delicate linework, slightly soft-focused so a foreground character stands out.";

/** S6c §3：参考图指令（构图锁的前缀，说明参考图只用于相机）。 */
const REFERENCE_INSTRUCTION = "Use the reference image only for camera and layout.";

/** S6c §3：竖屏构图提示（mobile 额外追加）。 */
const MOBILE_COMPOSITION_NOTE = "Vertical composition, the cushion/table in the lower-middle area.";

/** S6c §3：spec 字段长度上限（字符）。 */
const MAX_FIELD_CHARS = 200;

/** 截断到 200 字符（按码点计）。 */
function truncate(text: string): string {
  const chars = [...text];
  return chars.length <= MAX_FIELD_CHARS ? text : chars.slice(0, MAX_FIELD_CHARS).join("");
}

/** 生图尺寸（S6c §3）：desktop 1536×1024；mobile 1024×1536。 */
export type SceneDevice = "desktop" | "mobile";

export type ComposedScenePrompt = {
  /** 完整提示词（参考图指令 + 场景 + 构图锁 + 画风锁）。 */
  prompt: string;
  /** 生图尺寸（OpenAI images API 的 `size` 参数）。 */
  size: "1536x1024" | "1024x1536";
};

/**
 * 纯函数：把 SceneSpec 拼成生图提示词。
 * 必然包含 `pack.sceneLock` 与 `SCENE_STYLE_LOCK` 原文（后置条件）。
 */
export function composeScenePrompt(spec: SceneSpec, pack: Pack, device: SceneDevice): ComposedScenePrompt {
  const size = device === "desktop" ? "1536x1024" : "1024x1536";
  const compositionNote = device === "mobile" ? ` ${MOBILE_COMPOSITION_NOTE}` : "";

  const scenePart = [
    `Scene: ${truncate(spec.location)}.`,
    `Time: ${truncate(spec.time)}.`,
    `Lighting: ${truncate(spec.lighting)}.`,
    `Props: ${spec.props.map(truncate).join(", ")}.`,
    `Palette: ${truncate(spec.palette)}.`,
    `Mood: ${truncate(spec.mood)}.`,
  ].join(" ");

  const prompt = [
    REFERENCE_INSTRUCTION,
    scenePart,
    pack.sceneLock,
    SCENE_STYLE_LOCK + compositionNote,
  ].join(" ");

  return { prompt, size };
}
