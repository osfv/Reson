import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { bands, spectrumStale } from "../../store/spectrum";

/**
 * A mirrored spectrum along the bottom of Now Playing. Band levels arrive ~40 times a second;
 * the canvas eases toward them every frame so motion stays fluid at the display's refresh rate.
 */
export function SpectrumBars() {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) return;
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const shown = new Float32Array(bands.length);
    let color = "";
    let colorAt = 0;
    let raf = 0;

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      if (now - colorAt > 400) {
        color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#f2f1ee";
        colorAt = now;
      }
      const stale = spectrumStale();
      for (let i = 0; i < shown.length; i++) {
        const target = stale ? 0 : bands[i];
        shown[i] += (target - shown[i]) * (target > shown[i] ? 0.45 : stale ? 0.08 : 0.2);
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const n = shown.length;
      const slot = w / (n * 2);
      const barW = Math.max(2, slot * 0.5);
      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, color);
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      // Lows in the middle, highs toward both edges.
      for (let i = 0; i < n; i++) {
        const level = shown[i];
        const bh = Math.max(1.5, level * h * 0.95);
        const r = Math.min(barW / 2, bh / 2);
        for (const x of [w / 2 + i * slot + (slot - barW) / 2, w / 2 - (i + 1) * slot + (slot - barW) / 2]) {
          ctx.beginPath();
          ctx.roundRect(x, h - bh, barW, bh, [r, r, 0, 0]);
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  if (reduce) return null;
  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-24 w-full opacity-45" />;
}
