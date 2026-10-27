/**
 * 舞台渲染器（S6b §3）：按角色包的 `renderer.kind` 选渲染方式。
 *
 * - `layered`：夏凛现有的分层立绘（图层由 `composeStage` 产出）。
 * - `live2d`：忧奈的 Cubism 模型（复用 S6a 的 `createYunaRenderer` + `yunaParams`）。
 *
 * 状态机 B 的输出（phase / emotion / mouth / look）接到 `yunaParams`；
 * 口型继续由音量驱动（D34）——`mouth` 已由 B 根据 AnalyserNode 的 RMS 算好。
 *
 * 本组件只做渲染，不含决策：参数全部来自纯函数。
 */
import { useEffect, useRef, useState } from "react";
import type { Emotion } from "@mira/protocol";
import type { StagePerformance, StagePhase } from "../view/useStageViewModel";
import { createYunaRenderer, YunaLoadError, type YunaRendererHandle } from "../render/live2d/cubism/yunaRenderer";
import { yunaParams } from "../render/live2d/yunaParams";
import { toYunaEmotion } from "./emotionMap";
import { composeStage, type Orientation, type StageLayer } from "../stage/layers";
import { charClipBottom, containRect } from "../stage/charClip";
import type { Visual } from "../state";
import type { StoryMediaStatus } from "../state/storyMedia";

/** 夏凛分层立绘素材纵横比（宽/高）：角色基底与前景桌。 */
const RIN_CHAR_ASPECT = 1024 / 1536;
const RIN_TABLE_ASPECT = 1024 / 1024;

export type StageRendererProps = {
  characterId: string;
  renderer: "layered" | "live2d";
  phase: StagePhase;
  visual: Visual;
  performance: StagePerformance;
  storyMedia: { status: StoryMediaStatus; media: { type: string; id: string; url?: string } | null };
  orientation: Orientation;
  develop: number;
  /** 背景图（来自 pack.stage.background，按方向选）。 */
  backgroundUrl: string;
};

/** 分层立绘（夏凛）：沿用 `composeStage` 的图层。 */
function LayeredStage({
  layers,
  background,
  clipCharToTable,
}: {
  layers: StageLayer[];
  background: string;
  /** S6b-fix2 §2：手机竖屏为 true——角色图层按前景桌完全不透明下沿裁切。 */
  clipCharToTable: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [charClip, setCharClip] = useState(0);

  useEffect(() => {
    if (!clipCharToTable) {
      setCharClip(0);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const update = (): void => {
      const rect = root.getBoundingClientRect();
      // 图层容器 = 舞台去掉底部 120px（live.css .live-mobile-stage .live-layer）。
      const container = { width: rect.width, height: Math.max(0, rect.height - 120) };
      const char = containRect(container, RIN_CHAR_ASPECT);
      const table = containRect(container, RIN_TABLE_ASPECT);
      setCharClip(charClipBottom(char, table));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, [clipCharToTable]);

  return (
    <div ref={rootRef} className="live-layered-root" style={{ ["--char-clip" as never]: `${charClip}px` }}>
      <div className="live-bg" style={{ backgroundImage: `url(${background})` }} />
      {layers
        .filter((layer) => layer.id !== "bg:main")
        .map((layer) => {
          if (layer.id === "fx:glow") {
            return <div key={layer.id} className="live-glow" style={{ zIndex: layer.z, opacity: layer.opacity }} />;
          }
          if (layer.id === "photo:card") {
            return (
              <div key={layer.id} className="live-photo-card" style={{ zIndex: layer.z }} data-testid="photo-card" />
            );
          }
          if (layer.id === "photo:image") {
            return (
              <div key={layer.id} className="live-photo" data-testid="stage-photo" style={{ zIndex: layer.z }}>
                <img src={layer.src} alt="" style={{ opacity: layer.opacity }} />
              </div>
            );
          }
          // S6b-fix2 §2：手机竖屏裁角色图层（char: 前缀），前景桌不裁。
          const isChar = layer.id.startsWith("char:");
          const clip = clipCharToTable && isChar && charClip > 0 ? `inset(0 0 ${charClip}px 0)` : undefined;
          return (
            <div
              key={layer.id}
              className="live-layer"
              data-layer-id={layer.id}
              style={{
                zIndex: layer.z,
                transform: layer.transform === "none" ? undefined : layer.transform,
                clipPath: clip,
              }}
            >
              <img src={layer.src} alt="" style={{ opacity: layer.opacity }} />
            </div>
          );
        })}
    </div>
  );
}

/** 忧奈 Live2D：画布 + 脚下接触阴影。 */
function Live2dStage({
  phase,
  emotion,
  performance,
  background,
}: {
  phase: StagePhase;
  emotion: Emotion;
  performance: StagePerformance;
  background: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef({ phase, emotion, performance });
  frameRef.current = { phase, emotion, performance };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let handle: YunaRendererHandle | null = null;
    let disposed = false;

    void createYunaRenderer({
      canvas,
      fitMode: "live",
      frame: () => {
        const { phase: currentPhase, emotion: currentEmotion, performance: current } = frameRef.current;
        // 注意：这里不能用名为 `performance` 的局部变量，否则会遮住全局 performance。
        const tSec = (typeof globalThis.performance !== "undefined" ? globalThis.performance.now() : Date.now()) / 1000;
        const yunaEmotion = toYunaEmotion(currentEmotion);
        const blinkOpen = current.blink === "closed" ? 0 : current.blink === "half" ? 0.5 : 1;
        return {
          params: yunaParams({
            phase: currentPhase,
            emotion: yunaEmotion,
            mouth: current.mouth,
            blinkOpen,
            tSec,
          }),
          emotion: yunaEmotion,
          manualBlink: blinkOpen,
        };
      },
    })
      .then((created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        handle = created;
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setError(cause instanceof YunaLoadError ? cause.message : "模型加载失败");
      });

    return () => {
      disposed = true;
      handle?.dispose();
    };
  }, []);

  return (
    <>
      <div className="live-bg" style={{ backgroundImage: `url(${background})` }} />
      {/* S6b §3：脚下柔和的椭圆接触阴影（宽约人物宽度 70%，半透明深紫），避免人物悬空。 */}
      <div className="live-contact-shadow" data-testid="contact-shadow" aria-hidden />
      <canvas ref={canvasRef} className="live-live2d-canvas" data-testid="yuna-canvas" />
      {error !== null && (
        <p className="live-error" data-testid="yuna-error">
          {error}
        </p>
      )}
    </>
  );
}

export function StageRenderer(props: StageRendererProps) {
  if (props.renderer === "live2d") {
    return (
      <Live2dStage
        phase={props.phase}
        emotion={props.visual.emotion}
        performance={props.performance}
        background={props.backgroundUrl}
      />
    );
  }
  const layers = composeStage({
    phase: props.phase,
    visual: props.visual,
    performance: {
      face: props.performance.face,
      blink: props.performance.blink,
      mouth: props.performance.mouth,
      hands: props.performance.hands,
      handsTransition: props.performance.handsTransition,
    },
    storyMedia: {
      status: props.storyMedia.status,
      media: props.storyMedia.media as never,
    },
    orientation: props.orientation,
    develop: props.develop,
  });
  // S6b-fix2 §2：手机竖屏（portrait）裁切角色图层；桌面横版布局不受影响。
  return <LayeredStage layers={layers} background={props.backgroundUrl} clipCharToTable={props.orientation === "portrait"} />;
}
