import { motion, useReducedMotion } from "motion/react";
import { Cover } from "../components/Cover";
import { firstAppearance } from "../components/AlbumGrid";
import { PageHeader } from "../components/PageHeader";
import { plural } from "../lib/format";
import { useLibrary, type Artist } from "../store/library";
import { useUi } from "../store/ui";

export function ArtistCard({ artist, index = 0 }: { artist: Artist; index?: number }) {
  const navigate = useUi((s) => s.navigate);
  const reduce = useReducedMotion();
  const cover = artist.albums.find((a) => a.cover) ?? artist.albums[0];
  const animateIn = !reduce && firstAppearance(`artist:${artist.name}`);
  return (
    <motion.button
      type="button"
      initial={animateIn ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: Math.min(index, 18) * 0.025, ease: [0.16, 1, 0.3, 1] }}
      onClick={() => navigate({ name: "artist", artist: artist.name })}
      className="group min-w-0 text-left"
    >
      <Cover
        album={cover}
        round
        className="aspect-square w-full shadow-[0_18px_40px_-18px_rgb(0_0_0/0.7)] transition-transform duration-300 ease-out-expo group-hover:-translate-y-1"
      />
      <span className="mt-3 block truncate text-center text-sm font-medium">{artist.name}</span>
      <span className="mt-0.5 block truncate text-center text-[13px] text-ink-muted">
        {artist.albums.length > 1 ? plural(artist.albums.length, "album") : plural(artist.tracks.length, "song")}
      </span>
    </motion.button>
  );
}

export function ArtistsView() {
  const artists = useLibrary((s) => s.artists);
  return (
    <div className="pb-16">
      <PageHeader title="Artists" meta={plural(artists.length, "artist")} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-6 gap-y-8 px-8">
        {artists.map((a, i) => (
          <ArtistCard key={a.name} artist={a} index={i} />
        ))}
      </div>
    </div>
  );
}
