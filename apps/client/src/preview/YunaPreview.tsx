/**
 * 忧奈 Live2D 预览页（S6a §1.4）。URL 带 `?preview=yuna` 时由 `main.tsx` 渲染。
 *
 * 左边画布显示忧奈（胸像到大腿的构图），右边一个调试面板：
 * phase / emotion / mouth（含「自动说话」开关）/ 手动眨眼按钮；面板显示 FPS 与贴图尺寸。
 * 决策逻辑全在纯函数 `yunaParams`；本组件只负责「逐帧取样 + 驱动外壳」。
 *
 * 模型加载失败：画布位置显示错误卡片，「不」回退到夏凛。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createYunaRenderer, YunaLoadError, type YunaRendererHandle } from "../render/live2d/cubism/yunaRenderer";
import { yunaParams, type YunaEmotion } from "../render/live2d/yunaParams";
import type { MouthShape, StagePhaseKind } from "../state/performance";
import "./preview.css";

/**
 * §4.1：开发探针——`?preview=yuna&param=<id>&value=<v>` 把单个参数强制置为该值。
 * 用于逐参数实测（min / max 下的画面变化），只在带 query 时生效，不影响正常预览页。
 * 物理**输出**类参数（手 / 尾 / 耳）在物理之后会被覆盖，故对这些参数同时走物理后覆盖。
 *
 * freeze-fix9 §1：新增 `window.__setProbeCombo(map)`，一次强制**多个**参数（验证挥手所需的
 * 「大臂 + 小臂 + 手」组合），避免逐参数探针无法反映真实组合效果。
 */
const PROBE_PHYSICS_OUTPUT = /^Param(Hand|HandHold|HandTurn|Boom|Foream|Tail|Ears(L|R))/;

type Probe = { params: Record<string, number> } | null;

/** 探针状态：既可来自 URL query，也可由 e2e 通过 `window.__setProbe` / `__setProbeCombo` 运行时改写。 */
let runtimeProbe: Probe = null;

/** freeze-fix9 §1：动画帧冻结的固定 tSec（null = 不冻结，按真实时钟）。 */
const frozenRef: { current: number | null } = { current: null };

declare global {
  interface Window {
    __setProbe?: (param: string | null, value?: number) => void;
    __setProbeCombo?: (params: Record<string, number> | null) => void;
    /** freeze-fix9 §1：冻结动画帧到固定 tSec（null = 解冻）。探针实测用。 */
    __freezeFrame?: (tSec: number | null) => void;
    __probeReady?: boolean;
  }
}

function readProbe(): Probe {
  if (typeof window === "undefined") return null;
  if (runtimeProbe !== null) return runtimeProbe;
  const params = new URLSearchParams(window.location.search);
  const param = params.get("param");
  const valueRaw = params.get("value");
  if (param === null || valueRaw === null) return null;
  const value = Number.parseFloat(valueRaw);
  if (!Number.isFinite(value)) return null;
  return { params: { [param]: value } };
}

const PHASES: StagePhaseKind[] = ["idle", "listening", "thinking", "speaking"];
const EMOTIONS: YunaEmotion[] = ["calm", "guarded", "sad", "warm"];
const MOUTHS: MouthShape[] = ["closed", "small", "open"];

/** 自动说话：每 120ms 换一次口型（随机 small / open，偶尔 closed）。 */
const AUTO_MOUTH_INTERVAL_MS = 120;
/** 手动眨眼：闭眼持续 90ms 后重新睁开。 */
const MANUAL_BLINK_MS = 90;

export function YunaPreview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<YunaRendererHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [eyeOpen, setEyeOpen] = useState(1);
  const [textureSize, setTextureSize] = useState({ width: 0, height: 0 });

  const [phase, setPhase] = useState<StagePhaseKind>("idle");
  const [emotion, setEmotion] = useState<YunaEmotion>("calm");
  const [mouth, setMouth] = useState<MouthShape>("closed");
  const [autoMouth, setAutoMouth] = useState(false);

  // 逐帧取样用的可变状态（不触发重渲染）。manualBlink 为手动眨眼值（1 = 不干预）。
  const stateRef = useRef({ phase, emotion, mouth, manualBlink: 1 });
  stateRef.current = { phase, emotion, mouth, manualBlink: stateRef.current.manualBlink };

  // 初始化渲染器。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let handle: YunaRendererHandle | null = null;

    // §4.1：e2e 可在运行时改探针（免去反复重载模型）。
    window.__setProbe = (param: string | null, value?: number) => {
      runtimeProbe = param === null ? null : { params: { [param]: value ?? 0 } };
    };
    // freeze-fix9 §1：一次改多个参数（挥手组合验证用）。
    window.__setProbeCombo = (params: Record<string, number> | null) => {
      runtimeProbe = params === null ? null : { params: { ...params } };
    };
    // freeze-fix9 §1：冻结 / 解冻动画帧（探针实测时消除呼吸 / 眨眼噪声）。
    window.__freezeFrame = (tSec: number | null) => {
      frozenRef.current = tSec;
    };
    createYunaRenderer({
      canvas,
      frame: () => {
        const { phase: p, emotion: e, mouth: m, manualBlink } = stateRef.current;
        // freeze-fix9 §1：冻结帧——探针实测时把动画钉在固定 tSec、关闭随机小动作，
        // 使「连续两帧」完全相同（静止噪声≈0），参数差异只来自被探测的参数。
        const tSec = frozenRef.current ?? (performance.now() - startedAt) / 1000;
        const params = yunaParams({
          phase: p,
          emotion: e,
          mouth: m,
          // blinkOpen 只用于纯函数算出基准睁眼值；实际自动眨眼由外壳里的 EyeBlink 叠加。
          blinkOpen: 1,
          tSec,
          // 冻结时禁止待机小动作（否则 idleSinceSec 会引入随机视线）。
          idleSinceSec: frozenRef.current !== null ? 0 : undefined,
          seed: 0,
        });
        // §4.1：探针强制覆盖单参数（物理输出类参数同时走物理后覆盖）。
        const probe = readProbe();
        if (probe !== null) {
          const names = Object.keys(probe.params);
          Object.assign(params, probe.params);
          const physicsTargets: Record<string, number> = {};
          for (const name of names) {
            if (PROBE_PHYSICS_OUTPUT.test(name)) physicsTargets[name] = probe.params[name] as number;
          }
          if (Object.keys(physicsTargets).length > 0) {
            return {
              params,
              emotion: e,
              // 冻结时也关掉自动眨眼（固定 manualBlink=1，仍会被 EyeBlink 叠加随机眨眼）。
              manualBlink,
              postPhysics: { target: physicsTargets, weight: 1 },
            };
          }
        }
        return { params, emotion: e, manualBlink };
      },
    })
      .then((created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        handle = created;
        rendererRef.current = created;
        setTextureSize(created.textureSize());
        window.__probeReady = true;
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setError(cause instanceof YunaLoadError ? cause.message : String(cause));
      });

    const startedAt = performance.now();
    return () => {
      disposed = true;
      handle?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // FPS 统计 + 贴图尺寸刷新 + 睁眼读数的滑动最小值（仅 1s 采样一次，避免每帧重渲染）。
  useEffect(() => {
    let frames = 0;
    let lastSample = performance.now();
    let minOpen = 1;
    let raf = 0;
    const tick = (): void => {
      frames += 1;
      const open = rendererRef.current?.eyeOpen();
      if (open !== undefined) minOpen = Math.min(minOpen, open);
      const now = performance.now();
      if (now - lastSample >= 1000) {
        setFps(Math.round((frames * 1000) / (now - lastSample)));
        // 只读调试值：e2e 用它断言自动眨眼确实把眼睛闭到了 < 0.3。
        setEyeOpen(minOpen);
        minOpen = 1;
        frames = 0;
        lastSample = now;
        const size = rendererRef.current?.textureSize();
        if (size) setTextureSize(size);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 自动说话：随机节奏切口型。
  useEffect(() => {
    if (!autoMouth) return;
    const timer = window.setInterval(() => {
      const roll = Math.random();
      setMouth(roll < 0.2 ? "closed" : roll < 0.6 ? "small" : "open");
    }, AUTO_MOUTH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoMouth]);

  const manualBlink = useCallback(() => {
    stateRef.current.manualBlink = 0;
    window.setTimeout(() => {
      stateRef.current.manualBlink = 1;
    }, MANUAL_BLINK_MS);
  }, []);

  // canvas 尺寸跟随容器（S6a-fix2 §1：填满左侧区域，随窗口自适应；DPR 上限 2 在渲染器里夹紧）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = (): void => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      if (width <= 0 || height <= 0) return;
      rendererRef.current?.resize(width, height, window.devicePixelRatio);
    };
    resize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", resize);
      return () => window.removeEventListener("resize", resize);
    }
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="preview-root" data-testid="yuna-preview">
      <div className="preview-stage">
        {error !== null ? (
          <div className="preview-error" data-testid="yuna-error">
            {`模型加载失败：${error}`}
          </div>
        ) : (
          <canvas ref={canvasRef} className="preview-canvas" data-testid="yuna-canvas" data-eye-open={eyeOpen.toFixed(3)} />
        )}
      </div>

      <aside className="preview-panel" data-testid="yuna-panel">
        <p data-testid="preview-fps">{`FPS ${fps}`}</p>
        <p data-testid="preview-eye-open">{`eyeOpen ${eyeOpen.toFixed(3)}`}</p>
        <p data-testid="preview-texture">{`贴图 ${textureSize.width}×${textureSize.height}`}</p>

        <fieldset>
          <legend>phase</legend>
          {PHASES.map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="phase"
                checked={phase === value}
                onChange={() => setPhase(value)}
              />
              {value}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>emotion</legend>
          {EMOTIONS.map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="emotion"
                checked={emotion === value}
                onChange={() => setEmotion(value)}
              />
              {value}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>mouth</legend>
          {MOUTHS.map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="mouth"
                checked={mouth === value}
                onChange={() => {
                  setAutoMouth(false);
                  setMouth(value);
                }}
              />
              {value}
            </label>
          ))}
          <label>
            <input type="checkbox" checked={autoMouth} onChange={() => setAutoMouth((v) => !v)} />
            自动说话
          </label>
        </fieldset>

        <button type="button" onClick={manualBlink} data-testid="blink-button">
          眨眼
        </button>
      </aside>
    </main>
  );
}
