import { useDeferredValue, useMemo } from "react";
import { AlbumGrid } from "../components/AlbumGrid";
import { TrackList } from "../components/TrackList";
import { useLibrary } from "../store/library";
import { useUi } from "../store/ui";
import { ArtistCard } from "./ArtistsView";

const norm = (s: string) => s.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function SearchView() {
  const query = useDeferredValue(useUi((s) => s.query));
  const tracks = useLibrary((s) => s.tracks);
  const albums = useLibrary((s) => s.albums);
  const artists = useLibrary((s) => s.artists);
  const albumById = useLibrary((s) => s.albumById);

  const results = useMemo(() => {
    const terms = norm(query).split(/\s+/).filter(Boolean);
    const match = (...fields: (string | null | undefined)[]) => {
      const hay = norm(fields.filter(Boolean).join(" "));
      return terms.every((t) => hay.includes(t));
    };
    return {
      tracks: tracks.filter((t) => match(t.title, t.artist, albumById.get(t.albumId)?.title)).slice(0, 50),
      albums: albums.filter((a) => match(a.title, a.artist)).slice(0, 12),
      artists: artists.filter((a) => match(a.name)).slice(0, 8),
    };
  }, [query, tracks, albums, artists, albumById]);

  const nothing = !results.tracks.length && !results.albums.length && !results.artists.length;

  return (
    <div className="pb-16 pt-4">
      {nothing ? (
        <div className="px-8 pt-12">
          <h1 className="text-2xl font-semibold tracking-tight">No matches for “{query}”</h1>
          <p className="mt-2 text-sm text-ink-muted">Check the spelling, or try fewer words.</p>
        </div>
      ) : (
        <>
          {results.tracks.length > 0 && (
            <section>
              <h2 className="mb-3 px-8 text-xl font-semibold tracking-tight">Songs</h2>
              <TrackList tracks={results.tracks} />
            </section>
          )}
          {results.albums.length > 0 && (
            <section className="mt-12 px-8">
              <h2 className="mb-5 text-xl font-semibold tracking-tight">Albums</h2>
              <AlbumGrid albums={results.albums} />
            </section>
          )}
          {results.artists.length > 0 && (
            <section className="mt-12 px-8">
              <h2 className="mb-5 text-xl font-semibold tracking-tight">Artists</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-6">
                {results.artists.map((a, i) => (
                  <ArtistCard key={a.name} artist={a} index={i} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
