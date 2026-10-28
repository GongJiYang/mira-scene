/**
 * freeze-fix3 §2：判定本会话是否存在「已调度、未就绪」的剧情照片事件（纯函数）。
 *
 * 输入是三个 id 集合（顺序无关，只看成员关系）：
 * - `scheduled`：本会话已调度的剧情照片事件（`scheduleMediaDelivery` 时登记）；
 * - `ready`：已经就绪（收到 media_ready{status:ready}）的照片事件；
 * - `failed`：已经失败、走预置图兜底的照片事件。
 *
 * 有任意一个 `scheduled` 里的 id 既不在 `ready` 也不在 `failed` 里 → 仍有照片在等待。
 * 视频事件不在此列（本判定只服务截图等待的铺垫）。
 */
export type WaitingPhotoInput = {
  scheduled: Iterable<string>;
  ready: ReadonlySet<string>;
  failed?: ReadonlySet<string>;
};

export function hasWaitingPhoto(input: WaitingPhotoInput): boolean {
  const failed = input.failed ?? new Set<string>();
  for (const id of input.scheduled) {
    if (!input.ready.has(id) && !failed.has(id)) return true;
  }
  return false;
}
