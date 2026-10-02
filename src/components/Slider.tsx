import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { motion, useMotionValue, useMotionValueEvent, useTransform, type MotionValue } from "motion/react";
import { cn } from "../lib/cn";

interface SliderProps {
  value: number;
  max: number;
  label: string;
  step?: number;
  onCommit: (v: number) => void;
  onLive?: (v: number | null) => void;
  /** Per-frame source (the playback clock). When set, the slider follows it instead of `value`. */
  live?: MotionValue<number>;
  /** When set, hovering shows a tooltip with the value under the cursor. */
  format?: (v: number) => string;
  /** Mouse wheel nudges the value by `step`. */
  wheel?: boolean;
  className?: string;
  thick?: boolean;
}

export function Slider({ value, max, label, step, onCommit, onLive, live, format, wheel, className, thick }: SliderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  const shown = useMotionValue(live?.get() ?? value);
  const s = step ?? max / 20;

  // The displayed value follows the live clock / prop, except while the user is dragging.
  useMotionValueEvent(live ?? shown, "change", (v) => {
    if (live && !dragging.current) shown.set(v);
  });
  useEffect(() => {
    if (!live && !dragging.current) shown.set(value);
  }, [value, live, shown]);

  const pct = useTransform(shown, (v) => (max > 0 ? Math.min(1, Math.max(0, v / max)) : 0));
  const left = useTransform(pct, (p) => `${p * 100}%`);

  const fraction = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const update = (v: number | null) => {
    dragging.current = v != null;
    setDrag(v);
    if (v != null) shown.set(v);
    onLive?.(v);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (max <= 0 || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    update(fraction(e.clientX) * max);
  };
  const onPointerMove = (e: PointerEvent) => {
    const f = fraction(e.clientX);
    if (format) setHover(f);
    if (dragging.current) update(f * max);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragging.current) return;
    const v = fraction(e.clientX) * max;
    onCommit(v);
    shown.set(v);
    update(null);
  };
  const current = () => shown.get();
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") onCommit(Math.min(max, current() + s));
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") onCommit(Math.max(0, current() - s));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onWheel = (e: WheelEvent) => {
    if (!wheel || max <= 0) return;
    onCommit(Math.min(max, Math.max(0, current() + (e.deltaY < 0 ? s : -s))));
  };

  const tip = drag != null ? drag / max : hover;

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(drag ?? value)}
      aria-valuetext={format ? format(drag ?? value) : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(null)}
      onPointerUp={onPointerUp}
      onPointerCancel={() => update(null)}
      onKeyDown={onKeyDown}
      onWheel={onWheel}
      className={cn("group relative flex h-4 touch-none items-center", className)}
    >
      <div
        className={cn(
          "relative w-full overflow-hidden rounded-full bg-white/15 transition-transform duration-200 ease-out-expo group-hover:scale-y-[1.6]",
          drag != null && "scale-y-[1.6]",
          thick ? "h-1.5" : "h-1",
        )}
      >
        {/* Hover preview of where a click would land. */}
        {tip != null && drag == null && format && (
          <div className="absolute inset-0 origin-left rounded-full bg-white/15" style={{ transform: `scaleX(${tip})` }} />
        )}
        <motion.div
          className={cn("absolute inset-0 origin-left rounded-full", drag != null ? "bg-accent" : "bg-ink group-hover:bg-accent")}
          style={{ scaleX: pct }}
        />
      </div>
      <motion.div
        className={cn(
          "pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink shadow-md transition-[opacity,scale] duration-150",
          drag != null ? "scale-110 opacity-100" : "scale-75 opacity-0 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:opacity-100",
        )}
        style={{ left }}
      />
      {format && tip != null && (
        <div
          className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-md bg-ink px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#141416] shadow-lg tabular-nums"
          style={{ left: `${tip * 100}%` }}
        >
          {format(tip * max)}
        </div>
      )}
    </div>
  );
}

/** Text that shows a motion value formatted, updating the DOM directly (no React re-render). */
export function LiveText({ value, format, className }: { value: MotionValue<number>; format: (v: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef("");
  const write = (v: number) => {
    const text = format(v);
    if (text !== last.current && ref.current) {
      last.current = text;
      ref.current.textContent = text;
    }
  };
  useMotionValueEvent(value, "change", write);
  useEffect(() => write(value.get()));
  return <span ref={ref} className={className} />;
}
