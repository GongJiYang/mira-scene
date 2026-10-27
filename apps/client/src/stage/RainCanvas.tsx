import { useEffect, useRef } from "react";
import type { Fx } from "@mira/protocol";
import { rainParams } from "./rain";

type Drop = { x: number; y: number; len: number; spd: number };

/**
 * 雨（1 个 canvas，§3）。数量与速度由 `rainParams` 决定；
 * `prefers-reduced-motion` 时雨量减半（透传给纯函数）。
 */
export function RainCanvas({ fx, reducedMotion }: { fx: Fx | null; reducedMotion: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<Fx | null>(fx);
  const fxSinceRef = useRef(0);
  const reducedRef = useRef(reducedMotion);

  useEffect(() => {
    if (fxRef.current !== fx) {
      fxRef.current = fx;
      // rain_stop 的 4s 渐停从这里开始计时。
      fxSinceRef.current = performance.now();
    }
  }, [fx]);

  useEffect(() => {
    reducedRef.current = reducedMotion;
  }, [reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let drops: Drop[] = [];

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const tick = (): void => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const params = rainParams(fxRef.current, performance.now() - fxSinceRef.current, reducedRef.current);

      while (drops.length < params.count) {
        drops.push({ x: Math.random() * width, y: Math.random() * height, len: 8 + Math.random() * 16, spd: 0.5 + Math.random() * 0.9 });
      }
      if (drops.length > params.count) drops.length = params.count;

      ctx.clearRect(0, 0, width, height);
      if (params.count > 0 && params.alpha > 0) {
        ctx.strokeStyle = `rgba(198, 219, 255, ${params.alpha})`;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (const drop of drops) {
          drop.y += drop.spd * params.speed * 6;
          drop.x -= drop.spd * params.speed * 1.4;
          if (drop.y > height + drop.len) {
            drop.y = -drop.len;
            drop.x = Math.random() * width;
          }
          if (drop.x < -drop.len) drop.x = width + drop.len;
          ctx.moveTo(drop.x, drop.y);
          ctx.lineTo(drop.x - drop.len * 0.35, drop.y + drop.len);
        }
        ctx.stroke();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="stage-rain" aria-hidden="true" />;
}
