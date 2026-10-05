import { useEffect, useMemo } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { Album, Track, YearStats } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useLibrary } from "../../store/library";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const monthName = (i: number) => MONTH_NAMES[i] ?? "";

/** "1,234" that counts up from zero the first time it's shown. */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(reduce ? value : 0);
  const text = useTransform(mv, (v) => Math.round(v).toLocaleString());
  useEffect(() => {
    if (reduce) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, { duration: 1.4, ease: [0.16, 1, 0.3, 1] });
    return () => controls.stop();
  }, [value, reduce, mv]);
  return <motion.span className={className}>{text}</motion.span>;
}

export function formatDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

/** Resolves the ids in a YearStats against the library. */
export function useYearData(stats: YearStats | null) {
  const trackById = useLibrary((s) => s.trackById);
  const albumById = useLibrary((s) => s.albumById);
  return useMemo(() => {
    if (!stats) return null;
    const topTracks = stats.topTracks
      .map(([id, plays, minutes]) => ({ track: trackById.get(id), plays, minutes }))
      .filter((x): x is { track: Track; plays: number; minutes: number } => x.track != null);
    const topAlbums = stats.topAlbums
      .map(([id, plays, minutes]) => ({ album: albumById.get(id), plays, minutes }))
      .filter((x): x is { album: Album; plays: number; minutes: number } => x.album != null);
    const first = stats.firstTrack ? trackById.get(stats.firstTrack[0]) : undefined;
    const topMonth = stats.months.reduce((best, m, i) => (m > stats.months[best] ? i : best), 0);
    return { topTracks, topAlbums, first, topMonth, trackById, albumById };
  }, [stats, trackById, albumById]);
}

export function MonthChart({ months, highlight, tall }: { months: number[]; highlight: number; tall?: boolean }) {
  const max = Math.max(1, ...months);
  return (
    <div className={cn("flex items-end gap-2", tall ? "h-64" : "h-40")}>
      {months.map((m, i) => (
        <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
          <motion.div
            initial={{ scaleY: 0 }}
            whileInView={{ scaleY: 1 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.04, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            style={{ height: `${Math.max(2, (m / max) * 100)}%` }}
            className={cn("w-full origin-bottom rounded-md", i === highlight && m > 0 ? "bg-accent" : "bg-white/[0.14]")}
            title={`${monthName(i)}: ${Math.round(m).toLocaleString()} minutes`}
          />
          <span className={cn("font-mono text-[11px]", i === highlight && m > 0 ? "text-ink" : "text-ink-faint")}>{MONTHS[i]}</span>
        </div>
      ))}
    </div>
  );
}
