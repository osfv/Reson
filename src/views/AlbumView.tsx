import type { CSSProperties } from "react";
import { DotsThree, Shuffle } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { IconButton, PlayButton } from "../components/Buttons";
import { Cover } from "../components/Cover";
import { albumCoverId } from "../components/AlbumGrid";
import { TrackList } from "../components/TrackList";
import { api } from "../lib/api";
import { playTracks, shuffleTracks, trackMenu } from "../lib/actions";
import { formatTotal, plural } from "../lib/format";
import { paletteOf } from "../lib/theme";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { NotFound } from "./NotFound";

export function AlbumView({ id }: { id: number }) {
  const album = useLibrary((s) => s.albumById.get(id));
  const tracks = useLibrary((s) => s.albumTracks.get(id)) ?? [];
  const navigate = useUi((s) => s.navigate);
  const openMenu = useUi((s) => s.openMenu);
  const reduce = useReducedMotion();
  const playingHere = usePlayer((s) => {
    const cur = s.index != null ? s.queue[s.index]?.id : undefined;
    return s.playing && tracks.some((t) => t.id === cur);
  });

  if (!album) return <NotFound what="album" />;
  const p = paletteOf(album);
  const ids = tracks.map((t) => t.id);
  const total = tracks.reduce((s, t) => s + t.duration, 0);

  return (
    // Scope the album's own palette to this page so its accent wins over the playing track's.
    <div className="relative pb-16" style={{ "--accent": p.accent, "--on-accent": p.onAccent } as CSSProperties}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-16 h-[420px]"
        style={{ background: `linear-gradient(180deg, ${p.surface}, transparent)` }}
      />
      <header className="relative flex flex-col gap-8 px-8 pb-8 pt-2 md:flex-row md:items-end">
        {/* Shares its layoutId with the grid card, so the cover flies from the grid into place. */}
        <motion.div
          layoutId={albumCoverId(album.id)}
          transition={{ type: "spring", stiffness: 300, damping: 34 }}
          className="h-56 w-56 shrink-0 lg:h-60 lg:w-60"
        >
          <Cover album={album} className="h-full w-full shadow-[0_28px_60px_-20px_rgb(0_0_0/0.75)]" />
        </motion.div>
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
          className="min-w-0"
        >
          <h1 className="line-clamp-2 pb-1 text-4xl font-semibold leading-[1.08] tracking-tight lg:text-5xl">{album.title}</h1>
          <p className="mt-3 text-sm text-ink-muted">
            <button
              type="button"
              onClick={() => navigate({ name: "artist", artist: album.artist })}
              className="font-medium text-ink hover:underline"
            >
              {album.artist}
            </button>
            {album.year ? `, ${album.year}` : ""}
            <span className="text-ink-faint">
              {" "}
              · {plural(tracks.length, "song")}, {formatTotal(total)}
            </span>
          </p>
        </motion.div>
      </header>

      <div className="relative flex items-center gap-3 px-8 pb-6">
        <PlayButton playing={playingHere} onClick={() => (playingHere ? api.toggle() : playTracks(ids))} size={56} />
        <IconButton label="Shuffle album" onClick={() => shuffleTracks(ids)} className="h-11 w-11">
          <Shuffle size={22} />
        </IconButton>
        <IconButton
          label="More options"
          className="h-11 w-11"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.bottom + 6, trackMenu(ids).filter((i) => !i.label.startsWith("Go to album")));
          }}
        >
          <DotsThree size={24} weight="bold" />
        </IconButton>
      </div>

      <TrackList tracks={tracks} variant="album" />
    </div>
  );
}
