/**
 * D12：turnId 由客户端分配、单调递增；服务端只接受严格更大的值。
 */
export function isTurnIdAcceptable(lastSeen: number, incoming: number): boolean {
  return incoming > lastSeen;
}
