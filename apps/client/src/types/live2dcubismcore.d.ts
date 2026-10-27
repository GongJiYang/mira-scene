/**
 * Cubism Core 的全局类型（S6a §1.2）。
 *
 * Core 由 `index.html` 的 `<script src="/vendor/cubism/live2dcubismcore.min.js">` 本地加载，
 * 挂成全局 `Live2DCubismCore`，不是 ES 模块，所以在这里声明最小可用类型。
 * 完整定义见 CubismWebFramework 的 live2d 官方 d.ts，这里只声明本项目用到的部分。
 */
declare namespace Live2DCubismCore {
  namespace Version {
    function csmGetVersion(): number;
    function csmGetLatestMocVersion(): number;
  }

  namespace Logging {
    function csmSetLogFunction(logFunction: csmLogFunction | null): void;
    function csmGetLogFunction(): csmLogFunction | null;
  }

  namespace Memory {
    function initializeAmountOfMemory(size: number): void;
  }

  type csmLogFunction = (message: string) => void;

  class Moc {
    static fromArrayBuffer(buffer: ArrayBuffer, shouldCheckMocConsistency?: boolean): Moc;
    _ptr: unknown;
    release(): void;
  }
}
