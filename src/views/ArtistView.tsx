import { useMemo, type CSSProperties } from "react";
import { Shuffle } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { AlbumGrid } from "../components/AlbumGrid";
import { IconButton, PlayButton } from "../components/Buttons";
import { TrackList } from "../components/TrackList";
import { playTracks, shuffleTracks } from "../lib/actions";
import { plural } from "../lib/format";
import { coverSrc, paletteOf } from "../lib/theme";
import { useLibrary } from "../store/library";
import { NotFound } from "./NotFound";

export function ArtistView({ name }: { name: string }) {
  const artist = useLibrary((s) => s.artistByName.get(name));
  const albumTracks = useLibrary((s) => s.albumTracks);
  const reduce = useReducedMotion();

  const tracks = useMemo(
    () => (artist ? artist.albums.flatMap((a) => albumTracks.get(a.id) ?? []) : []),
    [artist, albumTracks],
  );
  if (!artist) return <NotFound what="artist" />;

  const hero = artist.albums.find((a) => a.cover);
  const p = paletteOf(hero);
  const src = coverSrc(hero?.cover);
  const ids = tracks.map((t) => t.id);

  return (
    <div className="relative pb-16" style={{ "--accent": p.accent, "--on-accent": p.onAccent } as CSSProperties}>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-16 h-[380px] overflow-hidden">
        {src && <img src={src} alt="" className="h-full w-full scale-125 object-cover opacity-40 blur-3xl" />}
        <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, transparent 20%, var(--bg))` }} />
      </div>

      <motion.header
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative px-8 pb-8 pt-16"
      >
        <h1 className="line-clamp-2 pb-1 text-5xl font-semibold leading-[1.05] tracking-tighter lg:text-6xl">{artist.name}</h1>
        <p className="mt-3 text-sm text-ink-muted">
          {plural(artist.albums.length, "album")}, {plural(tracks.length, "song")}
        </p>
      </motion.header>

      <div className="relative flex items-center gap-3 px-8 pb-8">
        <PlayButton playing={false} label={`Play ${artist.name}`} onClick={() => playTracks(ids)} size={56} />
        <IconButton label={`Shuffle ${artist.name}`} onClick={() => shuffleTracks(ids)} className="h-11 w-11">
          <Shuffle size={22} />
        </IconButton>
      </div>

      <section className="relative px-8">
        <h2 className="mb-5 text-xl font-semibold tracking-tight">Albums</h2>
        <AlbumGrid albums={artist.albums} />
      </section>

      <section className="relative mt-14">
        <h2 className="mb-3 px-8 text-xl font-semibold tracking-tight">All songs</h2>
        <TrackList tracks={tracks} />
      </section>
    </div>
  );
}
