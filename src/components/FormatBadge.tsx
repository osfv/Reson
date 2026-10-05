import type { Track } from "../lib/api";
import { cn } from "../lib/cn";
import { isLossless, qualityLabel } from "../lib/format";
import { flagged, qualityVerdict } from "../lib/quality";

/** Small pill showing the real audio format. Lossless formats pick up the accent color; a
 * lossless file that looks like it was made from a lossy one gets a "?" and loses the accent. */
export function FormatBadge({ track, className }: { track: Track; className?: string }) {
  if (!track.format) return null;
  const verdict = qualityVerdict(track);
  const suspect = flagged(verdict);
  const lossless = isLossless(track.format) && !suspect;
  const quality = qualityLabel(track);
  const title = [quality ? `${track.format}, ${quality}` : track.format, suspect ? verdict!.title : null].filter(Boolean).join(". ");
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-full px-1.5 font-mono text-[10px] font-medium leading-none tracking-wide",
        lossless
          ? "text-accent ring-1 ring-inset ring-[color-mix(in_oklab,var(--accent)_45%,transparent)]"
          : "text-ink-muted ring-1 ring-inset ring-white/15",
        className,
      )}
    >
      {track.format}
      {suspect && <span aria-label={verdict!.title}>?</span>}
    </span>
  );
}
