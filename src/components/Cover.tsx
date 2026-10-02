import { useState } from "react";
import { MusicNotesSimple } from "@phosphor-icons/react";
import type { Album } from "../lib/api";
import { cn } from "../lib/cn";
import { coverSrc } from "../lib/theme";

export function Cover({ album, className, round }: { album?: Album | null; className?: string; round?: boolean }) {
  const src = coverSrc(album?.cover);
  const [failed, setFailed] = useState<string | null>(null);
  const show = src && failed !== src;
  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden bg-white/[0.06]",
        round ? "rounded-full" : "rounded-lg",
        className,
      )}
    >
      {show ? (
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(src)}
          // A plain fade-in on mount. Gating visibility on the load event could leave covers
          // invisible if the event was missed (e.g. instantly cached images on remount).
          className="cover-in h-full w-full object-cover"
        />
      ) : (
        <div className="grid h-full w-full place-items-center text-ink-faint">
          <MusicNotesSimple size="38%" />
        </div>
      )}
    </div>
  );
}

/** 2x2 grid of album covers, or a single cover when there are fewer than four. */
export function Mosaic({ albums, className }: { albums: Album[]; className?: string }) {
  if (albums.length < 4) return <Cover album={albums[0]} className={className} />;
  return (
    <div className={cn("grid shrink-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-lg", className)}>
      {albums.slice(0, 4).map((a) => (
        <Cover key={a.id} album={a} className="h-full w-full rounded-none" />
      ))}
    </div>
  );
}
