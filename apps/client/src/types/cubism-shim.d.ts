/**
 * CubismWebFramework 的类型 shim（S6a §1.2）。
 *
 * 官方框架源码是本仓库 `vendor/CubismWebFramework/` 下的 TS 源码（vite 里以 `@cubism/*` 别名
 * 直接引用，运行时不改框架源码）。但框架源码在项目 strict 配置下会报大量类型错误，
 * 而任务要求「类型错误用 tsconfig 的 include/exclude 隔离，不要关掉项目自身的 strict」。
 *
 * 做法：本文件用 ambient module 声明 `@cubism/*`（只声明本项目实际用到的 API 子集），
 * tsc 由此不再编译框架源码；vite 的 `resolve.alias` 仍指向真实源码，运行时是官方实现。
 * 框架源码因此完全不改。
 */

declare module "@cubism/math/cubismmatrix44" {
  export class CubismMatrix44 {
    loadIdentity(): void;
    scale(x: number, y: number): void;
    scaleRelative(x: number, y: number): void;
    translate(x: number, y: number): void;
    translateRelative(x: number, y: number): void;
    multiplyByMatrix(m: CubismMatrix44): void;
    getArray(): Float32Array;
  }
}

declare module "@cubism/math/cubismmodelmatrix" {
  import { CubismMatrix44 } from "@cubism/math/cubismmatrix44";
  export class CubismModelMatrix extends CubismMatrix44 {
    setWidth(w: number): void;
    setHeight(h: number): void;
    setCenterPosition(x: number, y: number): void;
  }
}

declare module "@cubism/model/cubismmodel" {
  import { CubismId } from "@cubism/id/cubismid";
  export class CubismModel {
    setParameterValueById(id: CubismId | string, value: number, weight?: number): void;
    getParameterValueById(id: CubismId | string): number;
    /** S6m §1：物理后覆盖用。不存在时返回负值。 */
    getParameterIndex(id: CubismId | string): number;
    getParameterMinimumValue(parameterIndex: number): number;
    getParameterMaximumValue(parameterIndex: number): number;
    getParameterValueByIndex(parameterIndex: number): number;
    setParameterValueByIndex(parameterIndex: number, value: number, weight?: number): void;
    update(): void;
  }
}

declare module "@cubism/rendering/cubismrenderer_webgl" {
  import { CubismModel } from "@cubism/model/cubismmodel";
  export class CubismRenderer_WebGL {
    initialize(model: CubismModel, maskBufferCount?: number): void;
    startUp(gl: WebGLRenderingContext): void;
    bindTexture(modelTextureNo: number, glTexture: WebGLTexture): void;
    setMvpMatrix(matrix44: unknown): void;
    setRenderState(fbo: WebGLFramebuffer, viewport: number[]): void;
    setIsPremultipliedAlpha(enable: boolean): void;
    drawModel(shaderPath?: string | null): void;
    release(): void;
  }
}

declare module "@cubism/model/cubismusermodel" {
  import { CubismModel } from "@cubism/model/cubismmodel";
  import { CubismModelMatrix } from "@cubism/math/cubismmodelmatrix";
  import { CubismRenderer_WebGL } from "@cubism/rendering/cubismrenderer_webgl";
  export class CubismUserModel {
    loadModel(buffer: ArrayBuffer, shouldCheckMocConsistency?: boolean): void;
    isInitialized(): boolean;
    setInitialized(v: boolean): void;
    getModel(): CubismModel;
    getModelMatrix(): CubismModelMatrix;
    getRenderer(): CubismRenderer_WebGL;
    createRenderer(maskBufferCount?: number): void;
    release(): void;
  }
}

declare module "@cubism/effect/cubismeyeblink" {
  import { CubismModel } from "@cubism/model/cubismmodel";
  export class CubismEyeBlink {
    static create(modelSetting?: unknown): CubismEyeBlink;
    updateParameters(model: CubismModel, deltaTimeSeconds: number): void;
  }
}

declare module "@cubism/id/cubismidmanager" {
  export class CubismIdManager {
    getId(id: string): { readonly _ptr: unknown } | undefined;
  }
}

declare module "@cubism/live2dcubismframework" {
  import { CubismId } from "@cubism/id/cubismid";
  export class CubismFramework {
    static startUp(option?: Option | null): boolean;
    static initialize(memorySize?: number): void;
    static dispose(): void;
    static getIdManager(): { getId(id: string): CubismId };
  }
  export class Option {
    logFunction?: unknown;
    loggingLevel?: number;
  }
  export enum LogLevel {
    LogLevel_Off = 5,
  }
}

declare module "@cubism/id/cubismid" {
  export class CubismId {
    readonly _ptr: unknown;
  }
}

declare module "@cubism/cubismmodelsettingjson" {
  export class CubismModelSettingJson {
    constructor(buffer: ArrayBuffer, size: number);
    getModelFileName(): string;
    getTextureCount(): number;
    getTextureFileName(index: number): string;
    getPhysicsFileName(): string;
    getDisplayInfoFileName(): string;
  }
}

declare module "@cubism/physics/cubismphysics" {
  import { CubismModel } from "@cubism/model/cubismmodel";
  export class CubismPhysics {
    static create(buffer: ArrayBuffer, size: number): CubismPhysics;
    evaluate(model: CubismModel, deltaTimeSeconds: number): void;
  }
}
