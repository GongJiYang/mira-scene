/**
 * S6c §1：弹幕换背景识别（纯函数）。
 *
 * 关键词放在角色包 `content.json` 的 `sceneTriggers`（正则片段）。
 * 命中与否都不影响这一轮的正常对话：角色照常回话；命中时额外启动 §2–§4 的后台任务，
 * 并给本轮提示词的 `scene_notes` 追加一句「对方想换个背景，你这边正在换」。
 */

export type SceneRequest = { hit: boolean; raw: string };

/**
 * 纯函数：判断弹幕是否命中「换背景」请求。
 * `raw` 是观众原话（原样返回，供日志与提示词使用）。
 */
export function detectSceneRequest(text: string, triggerPattern: RegExp): SceneRequest {
  return { hit: triggerPattern.test(text), raw: text };
}
