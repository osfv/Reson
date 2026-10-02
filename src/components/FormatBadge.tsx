import type { Track } from "../lib/api";
import { cn } from "../lib/cn";
import { isLossless, qualityLabel } from "../lib/format";

/** Small pill showing the real audio format. Lossless formats pick up the accent color. */
export function FormatBadge({ track, className }: { track: Track; className?: string }) {
  if (!track.format) return null;
  const lossless = isLossless(track.format);
  const quality = qualityLabel(track);
  return (
    <span
      title={quality ? `${track.format}, ${quality}` : track.format}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 font-mono text-[10px] font-medium leading-none tracking-wide",
        lossless
          ? "text-accent ring-1 ring-inset ring-[color-mix(in_oklab,var(--accent)_45%,transparent)]"
          : "text-ink-muted ring-1 ring-inset ring-white/15",
        className,
      )}
    >
      {track.format}
    </span>
  );
}
