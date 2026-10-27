/**
 * 在 Node 里加载仓库自带的 Cubism Core 5.1.0（S6e §1）。
 *
 * Core 是一个 Emscripten 产物：`module.exports` 是一个工厂函数，调用后返回的模块对象带
 * `.then(cb)`，WASM 初始化完成后回调。它需要几个浏览器全局（`atob`/`btoa`/`Buffer`），
 * 所以在 `vm` 沙箱里补齐后再跑。
 *
 * 这是 I/O 外壳的一部分：只负责「把 Core 变成可用的 JS 对象」，不掺决策逻辑。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

/** Core 暴露给我们的最小面：`Moc` / `Model` / `Version`。 */
export type CubismCore = {
  Version: {
    csmGetVersion(): number;
    csmGetLatestMocVersion(): number;
  };
  Moc: {
    fromArrayBuffer(buffer: ArrayBuffer, shouldCheckMocConsistency?: boolean): unknown;
  };
  Model: {
    fromMoc(moc: unknown): CubismModel;
  };
};

/** Core `Model` 的运行时结构（部分字段，够本工具用）。 */
export type CubismModel = {
  parts: {
    count: number;
    ids: string[];
    /** 每个 part 的父 part 下标（-1 表示无父）。 */
    parentIndices: Int32Array;
  };
  drawables: {
    count: number;
    ids: string[];
    parentPartIndices: Int32Array;
    textureIndices: Int32Array;
    vertexCounts: Int32Array;
    indexCounts: Int32Array;
    vertexUvs: Float32Array[];
    indices: Uint16Array[];
  };
};

/** 加载 Core，返回初始化完成的实例。 */
export async function loadCore(corePath: string): Promise<CubismCore> {
  const code = readFileSync(corePath, "utf8");
  // lib 不含 DOM，WebAssembly 在 Node 运行时存在但类型里没有，用反射取值。
  const webAssembly = (globalThis as Record<string, unknown>).WebAssembly;
  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    exports: {},
    console,
    Buffer,
    TextDecoder,
    TextEncoder,
    performance,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    WebAssembly: webAssembly,
    Promise,
    atob: (s: string): string => Buffer.from(s, "base64").toString("binary"),
    btoa: (s: string): string => Buffer.from(s, "binary").toString("base64"),
  };
  sandbox.exports = sandbox.module;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, { filename: "live2dcubismcore.min.js" });

  const factory = (sandbox.module as { exports: unknown }).exports;
  if (typeof factory !== "function") {
    throw new Error("Cubism Core 加载失败：module.exports 不是工厂函数");
  }
  const moduleObject = (factory as () => { then(cb: () => void): unknown })();
  await new Promise<void>((resolve) => {
    moduleObject.then(() => resolve());
  });

  const core = sandbox.Live2DCubismCore as CubismCore | undefined;
  if (!core || typeof core.Model?.fromMoc !== "function") {
    throw new Error("Cubism Core 初始化后仍未暴露 Model.fromMoc");
  }
  return core;
}

/** 用 Core 从 moc3 字节建出模型。 */
export function loadModel(core: CubismCore, mocBytes: Uint8Array): CubismModel {
  const buffer = mocBytes.buffer.slice(
    mocBytes.byteOffset,
    mocBytes.byteOffset + mocBytes.byteLength,
  ) as ArrayBuffer;
  const moc = core.Moc.fromArrayBuffer(buffer);
  if (!moc) throw new Error("Moc.fromArrayBuffer 返回空，moc3 可能损坏");
  const model = core.Model.fromMoc(moc);
  if (!model) throw new Error("Model.fromMoc 返回空，无法建立模型");
  return model;
}
