/**
 * 忧奈 Live2D 渲染外壳（S6a §1.2）。
 *
 * 命令式外壳：加载 model3.json / moc3 / 贴图 / 物理，建一个 WebGL 画布，
 * 每帧接收「外部算好的参数」→ 写入模型 → 物理 → 更新 → 绘制。
 *
 * **本文件不写任何决策逻辑**：参数全部来自 §1.3 的纯函数 `yunaParams`，
 * 眨眼开合由框架自带的 `CubismEyeBlink` 提供（参数组 `EyeBlink` 已在 model3.json 声明）。
 *
 * 不使用 pixi-live2d-display（只支持 Cubism 4 Core）；直接跑 Cubism Web SDK 5。
 */
import { CubismEyeBlink } from "@cubism/effect/cubismeyeblink";
import { CubismFramework, Option } from "@cubism/live2dcubismframework";
import { CubismMatrix44 } from "@cubism/math/cubismmatrix44";
import { CubismModelSettingJson } from "@cubism/cubismmodelsettingjson";
import { CubismUserModel } from "@cubism/model/cubismusermodel";
import { CubismModel } from "@cubism/model/cubismmodel";
import { CubismPhysics } from "@cubism/physics/cubismphysics";
import {
  applyEyeOpen,
  approachParams,
  combineBlink,
  EMOTION_KEYS,
  type YunaEmotion,
} from "../yunaParams";
import type { PostPhysicsOverride } from "../postPhysics";
import { pushEvent } from "../../../core/store";
import {
  fitModel,
  FIT_PRESETS,
  LIVE_FIT_PRESETS,
  livePresetFor,
  MODEL_BOUNDS,
  presetFor,
  type FitPreset,
} from "./fit";

/**
 * S6b §3：构图预设的选择方式。
 * - `preview`（默认）：预览页构图（人物尽量大，S6a-fix2）。
 * - `live`：直播间构图（全身展示，桌面 80% / 手机 62%，见 `LIVE_FIT_PRESETS`）。
 */
export type FitMode = "preview" | "live";

function presetForMode(mode: FitMode, viewportW: number): FitPreset {
  if (mode === "live") return LIVE_FIT_PRESETS[livePresetFor(viewportW)];
  return FIT_PRESETS[presetFor(viewportW)];
}

export const YUNA_MODEL_URL = "/models/yuna/yuna.model3.json";

/** 模型加载或运行时错误的统一异常，供预览页显示错误卡片。 */
export class YunaLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YunaLoadError";
  }
}

type TextureImage = { texture: WebGLTexture; img: HTMLImageElement };

/** 一个可渲染的忧奈模型实例（持有 WebGL 资源，需显式 `dispose`）。 */
class YunaModel extends CubismUserModel {
  private textures: TextureImage[] = [];
  private physics: CubismPhysics | null = null;
  private eyeBlink: CubismEyeBlink | null = null;
  private activeTextureCount = 0;

  constructor(
    private readonly gl: WebGLRenderingContext,
    private canvasWidth: number,
    private canvasHeight: number,
    private viewportWidth: number = canvasWidth,
    private viewportHeight: number = canvasHeight,
    /** S6b §3：预览页 / 直播间两套构图。 */
    private readonly fitMode: FitMode = "preview",
  ) {
    super();
  }

  static async create(
    gl: WebGLRenderingContext,
    settings: CubismModelSettingJson,
    fitMode: FitMode = "preview",
  ): Promise<YunaModel> {
    const canvas = gl.canvas as HTMLCanvasElement;
    const model = new YunaModel(gl, canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight, fitMode);
    const mocUrl = `/models/yuna/${settings.getModelFileName()}`;
    const moc = await fetchArrayBuffer(mocUrl);
    model.loadModel(moc);
    // loadModel 不设置 initialized；模型创建失败时 getModel() 为 null。
    if (model.getModel() === null) throw new YunaLoadError(`模型初始化失败：${mocUrl}`);
    model.setInitialized(true);

    model.eyeBlink = CubismEyeBlink.create(settings);

    model.physics = await loadPhysics(settings);

    model.createRenderer(1);
    const renderer = model.getRenderer();
    // 关键：给渲染器注入 GL 上下文，否则 doDrawModel 直接 return（不产生任何像素）。
    renderer.startUp(gl);
    renderer.setIsPremultipliedAlpha(true);

    const textureCount = settings.getTextureCount();
    if (textureCount === 0) throw new YunaLoadError("model3.json 未声明贴图");
    for (let index = 0; index < textureCount; index += 1) {
      const name = settings.getTextureFileName(index);
      const path = `/models/yuna/${name}`;
      const { texture, img } = await createTexture(gl, path);
      model.textures.push({ texture, img });
      // 关键：把贴图绑到渲染器的纹理槽，否则 drawModel 没有可采样的贴图。
      renderer.bindTexture(index, texture);
    }
    model.activeTextureCount = textureCount;

    return model;
  }

  /**
   * 每帧由外壳调用：写参数 → EyeBlink → 读回并写最终睁眼值 → 物理 → **物理后覆盖** → 更新。
   * **每帧只调用一次 `model.update()`**（S6a-fix1 §2）。纯命令，无决策：
   * 最终睁眼值由纯函数 `combineBlink` + `applyEyeOpen` 算出；物理后覆盖的目标 / 权重由纯函数给出。
   */
  applyFrame(
    params: Record<string, number>,
    manualBlink: number,
    emotion: YunaEmotion,
    dtSec: number,
    postPhysics?: PostPhysicsOverride,
  ): void {
    const model: CubismModel = this.getModel();
    const idManager = CubismFramework.getIdManager();
    for (const [name, value] of Object.entries(params)) {
      const id = idManager.getId(name);
      if (id) model.setParameterValueById(id, value);
    }
    // 眨眼：框架自带的 EyeBlink 写 ParamEyeLOpen / ParamEyeROpen。
    if (this.eyeBlink !== null) {
      this.eyeBlink.updateParameters(model, dtSec);
    }
    // §2：读回 EyeBlink 写的自动开合值（0–1），与手动值相乘，再经情绪上限。
    this.lastAutoBlink = this.readEyeOpen();
    const eyeOpen = applyEyeOpen(combineBlink(this.lastAutoBlink, manualBlink), emotion);
    this.writeEyeOpen(eyeOpen);
    // 物理（使用外部传入的参数作为输入）。
    this.physics?.evaluate(model, dtSec);
    // S6m §1：物理**之后**、update **之前**按权重混入手 / 尾 / 耳的覆盖目标。
    if (postPhysics !== undefined && postPhysics.weight > 0) {
      this.applyPostPhysics(model, postPhysics);
    }
    model.update();
  }

  /**
   * S6m §1：物理后覆盖。`value = physicsValue * (1 - w) + clamp(target, modelMin, modelMax) * w`。
   * 参数范围从模型运行时读取（Cubism 的 parameter min/max），**不硬编码**；
   * 读不到的参数 id 跳过并 `pushEvent` 记一次（按 id 去重，避免每帧刷屏）。
   */
  private applyPostPhysics(model: CubismModel, override: PostPhysicsOverride): void {
    const idManager = CubismFramework.getIdManager();
    const { target, weight } = override;
    for (const [name, rawTarget] of Object.entries(target)) {
      const id = idManager.getId(name);
      const index = id ? model.getParameterIndex(id) : -1;
      if (index === undefined || index < 0) {
        if (!this.postPhysicsReported.has(name)) {
          this.postPhysicsReported.add(name);
          pushEvent(`postPhysics: 未知参数 ${name}（已跳过）`);
        }
        continue;
      }
      const min = model.getParameterMinimumValue(index);
      const max = model.getParameterMaximumValue(index);
      const clamped = Math.max(min, Math.min(max, rawTarget));
      const physValue = model.getParameterValueByIndex(index);
      model.setParameterValueByIndex(index, physValue * (1 - weight) + clamped * weight);
    }
  }

  /** S6m §1：已上报过的「未知参数」，避免每帧重复 pushEvent。 */
  private postPhysicsReported = new Set<string>();


  /** 上一帧读出并已交给外部的手动值（外壳不直接用，保留以便调试与测试）。 */
  private lastAutoBlink = 1;

  /** 读回 EyeBlink 写的 `ParamEyeLOpen`（0–1）。模型缺失时返回 1（不等于闭眼）。 */
  private readEyeOpen(): number {
    const model = this.getModel();
    const idManager = CubismFramework.getIdManager();
    const id = idManager.getId("ParamEyeLOpen");
    if (!id) return 1;
    return model.getParameterValueById(id);
  }

  /** 把最终睁眼值写回 `ParamEyeLOpen/ROpen`（值由纯函数 `applyEyeOpen` 给出）。 */
  private writeEyeOpen(value: number): void {
    const model = this.getModel();
    const idManager = CubismFramework.getIdManager();
    const left = idManager.getId("ParamEyeLOpen");
    const right = idManager.getId("ParamEyeROpen");
    if (left) model.setParameterValueById(left, value);
    if (right) model.setParameterValueById(right, value);
  }

  /** 当前 `ParamEyeLOpen` 的读数（预览页只读调试用）。 */
  getEyeOpen(): number {
    return this.readEyeOpen();
  }

  /** 在给定画布上绘制，按画布尺寸做好矩阵与视口（对齐官方 sample 的 ProjectionMatrix 用法）。 */
  draw(): void {
    const renderer = this.getRenderer();
    const projection = new CubismMatrix44();
    const width = this.canvasWidth;
    const height = this.canvasHeight;
    if (width <= 0 || height <= 0) return;

    // S6a-fix2 §3：构图（缩放 + 居中）由纯函数 `fitModel` 算出，外壳只负责写进矩阵。
    const viewportW = this.viewportWidth;
    const viewportH = this.viewportHeight;
    const preset = presetForMode(this.fitMode, viewportW);
    const fit = fitModel(viewportW, viewportH, MODEL_BOUNDS, preset);

    // 模型矩阵：把可见区域中心放到画布中心，再按 fit.scale 等比缩放。
    const modelMatrix = this.getModelMatrix();
    modelMatrix.loadIdentity();
    modelMatrix.scale(fit.scale, fit.scale);
    modelMatrix.translate(fit.x, fit.y);

    projection.loadIdentity();
    // 把归一化画布（宽 `2*W/H`、高 2.0、居中）映射到 NDC [-1,1]²：只需 X 方向 `H/W`。
    // 归一化画布与视口同宽高比，故不会拉伸像素（S6a-fix2 §3：任意画布宽高比都不出画、不变形）。
    projection.scale(viewportH / viewportW, 1.0);
    projection.multiplyByMatrix(modelMatrix);

    renderer.setMvpMatrix(projection);
    // 渲染到默认帧缓冲（null = 屏幕），视口铺满画布的物理像素。
    renderer.setRenderState(null as unknown as WebGLFramebuffer, [0, 0, width, height]);
    renderer.drawModel();
  }

  override release(): void {
    for (const { texture } of this.textures) this.gl.deleteTexture(texture);
    this.textures = [];
    super.release();
  }

  /**
   * 画布尺寸变化。`width/height` 是**物理像素**（canvas.width/height，用于视口与绘制），
   * `viewportW/viewportH` 是 **CSS 像素**（构图与宽高比计算用，与 DPR 无关，S6a-fix2 §1）。
   */
  setSize(width: number, height: number, viewportW: number, viewportH: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.viewportWidth = viewportW;
    this.viewportHeight = viewportH;
  }

  getTextureCount(): number {
    return this.activeTextureCount;
  }

  getTextureSize(index = 0): { width: number; height: number } {
    const entry = this.textures[index];
    if (!entry) return { width: 0, height: 0 };
    return { width: entry.img.naturalWidth, height: entry.img.naturalHeight };
  }
}

async function loadPhysics(settings: CubismModelSettingJson): Promise<CubismPhysics | null> {
  const name = settings.getPhysicsFileName();
  if (name === "") return null;
  const buffer = await fetchArrayBuffer(`/models/yuna/${name}`);
  return CubismPhysics.create(buffer, buffer.byteLength);
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new YunaLoadError(`${response.status} ${url}`);
  return response.arrayBuffer();
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

async function createTexture(gl: WebGLRenderingContext, url: string): Promise<{ texture: WebGLTexture; img: HTMLImageElement }> {
  const img = await loadImage(url);
  const texture = gl.createTexture();
  if (!texture) throw new YunaLoadError("创建 WebGL 贴图失败");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { texture, img };
}

let frameworkStarted = false;

function ensureFramework(): void {
  if (!frameworkStarted) {
    CubismFramework.startUp(new Option());
    CubismFramework.initialize();
    frameworkStarted = true;
  }
}

/** 一帧的目标参数 + 情绪 + 手动眨眼值（均由纯函数 `yunaParams` / 预览页提供）。 */
export type YunaFrame = {
  /** `yunaParams` 的目标参数（情绪键的平滑在外壳里做，键集合恒定）。 */
  params: Record<string, number>;
  /** 当前情绪（决定眼睛开合上限）。 */
  emotion: YunaEmotion;
  /** 手动眨眼值 0–1（预览页的按钮给出；无手动输入时为 1）。 */
  manualBlink: number;
  /** S6m §1：物理后覆盖（手 / 尾 / 耳），由 `postPhysicsParams` 给出；缺省不覆盖。 */
  postPhysics?: PostPhysicsOverride;
};

export type YunaRendererHandle = {
  /** 贴图尺寸（预览面板显示用）。 */
  textureSize(): { width: number; height: number };
  /** 当前 `ParamEyeLOpen` 读数（预览页只读调试用，e2e 据此断言自动眨眼）。 */
  eyeOpen(): number;
  resize(width: number, height: number, dpr?: number): void;
  dispose(): void;
};

export type CreateYunaRendererOptions = {
  canvas: HTMLCanvasElement;
  /** 参数提供者：每帧由外壳调用，返回目标参数 + 情绪 + 手动眨眼值（来源是纯函数 `yunaParams`）。 */
  frame: () => YunaFrame;
  /** S6b §3：构图模式，默认 `preview`（预览页）；直播间传 `live`。 */
  fitMode?: FitMode;
};

/** 情绪键平滑到位所需时间（S6a-fix1 §3：约 0.25 秒）。 */
export const EMOTION_SMOOTH_SEC = 0.25;

/** 渲染分辨率上限（S6a-fix2 §1：devicePixelRatio 上限 2，避免 4K 屏下过度绘制）。 */
export const MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * 创建忧奈渲染器：加载模型、开始 rAF 循环。加载失败抛 `YunaLoadError`。
 */
export async function createYunaRenderer(
  options: CreateYunaRendererOptions,
): Promise<YunaRendererHandle> {
  ensureFramework();

  const canvas = options.canvas;
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!gl) throw new YunaLoadError("浏览器不支持 WebGL");

  const settingsBuffer = await fetchArrayBuffer(YUNA_MODEL_URL);
  const settings = new CubismModelSettingJson(settingsBuffer, settingsBuffer.byteLength);
  if (settings.getModelFileName() === "") throw new YunaLoadError("model3.json 缺少 Moc 字段");

  const model = await YunaModel.create(gl, settings, options.fitMode ?? "preview");

  let running = true;
  let lastTime = performance.now();
  let rafId = 0;
  // 上一帧的情绪键值（平滑用；只含 EMOTION_KEYS）。
  let prevEmotion: Record<string, number> = {};

  const resize = (width: number, height: number, dpr = 1): void => {
    const ratio = Math.min(Math.max(dpr, 1), MAX_DEVICE_PIXEL_RATIO);
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    gl.viewport(0, 0, canvas.width, canvas.height);
    model.setSize(canvas.width, canvas.height, width, height);
  };
  resize(canvas.clientWidth || 720, canvas.clientHeight || 1080, window.devicePixelRatio);

  const loop = (): void => {
    if (!running) return;
    const now = performance.now();
    const dtSec = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.viewport(0, 0, canvas.width, canvas.height);

    const frame = options.frame();
    // §3：只对情绪键做逐帧平滑（呼吸 / 口型 / 视线不平滑）。
    const alpha = Math.min(1, dtSec / EMOTION_SMOOTH_SEC);
    const emotionTargets: Record<string, number> = {};
    for (const key of EMOTION_KEYS) emotionTargets[key] = frame.params[key] ?? 0;
    const smoothedEmotion = approachParams(prevEmotion, emotionTargets, alpha);
    prevEmotion = smoothedEmotion;
    const params = { ...frame.params, ...smoothedEmotion };

    // §2：自动眨眼（EyeBlink 写入并被外壳读回的 0–1 值）与手动值相乘后再经上限。
    // 组合与上限在纯函数 `combineBlink` / `applyEyeOpen` 里完成（applyFrame 内部调用）。
    // S6m §1：`frame.postPhysics` 在物理之后、update 之前按权重覆盖手 / 尾 / 耳。
    model.applyFrame(params, frame.manualBlink, frame.emotion, dtSec, frame.postPhysics);
    model.draw();

    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);

  return {
    textureSize: () => model.getTextureSize(),
    eyeOpen: () => model.getEyeOpen(),
    resize,
    dispose() {
      running = false;
      cancelAnimationFrame(rafId);
      model.release();
    },
  };
}
