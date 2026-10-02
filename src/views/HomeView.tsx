import { useMemo, type ReactNode } from "react";
import { Play } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { AlbumRow, firstAppearance } from "../components/AlbumGrid";
import { Cover, Mosaic } from "../components/Cover";
import { playTracks } from "../lib/actions";
import type { Album, Track } from "../lib/api";
import { plural } from "../lib/format";
import { beginDragGesture, clickSuppressed } from "../store/drag";
import { useHistory } from "../store/history";
import { albumCovers, useLibrary } from "../store/library";
import { useUi } from "../store/ui";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10 first:mt-2">
      <h2 className="mb-4 text-xl font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

/** Compact song tile for the "On repeat" grid. */
function SongTile({ track, plays, index, all }: { track: Track; plays: number; index: number; all: number[] }) {
  const album = useLibrary((s) => s.albumById.get(track.albumId));
  const reduce = useReducedMotion();
  const animateIn = !reduce && firstAppearance(`tile:${track.id}`);
  return (
    <motion.button
      type="button"
      initial={animateIn ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      onClick={() => !clickSuppressed() && playTracks(all, index)}
      onPointerDown={(e) => beginDragGesture(e, () => ({ trackIds: [track.id], label: track.title, source: { kind: "tracks" } }))}
      className="group flex items-center gap-3 overflow-hidden rounded-xl bg-white/[0.04] pr-3 text-left transition-colors hover:bg-white/[0.08]"
    >
      <span className="relative shrink-0">
        <Cover album={album} className="h-14 w-14 rounded-none" />
        <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
          <Play size={18} weight="fill" />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{track.title}</span>
        <span className="block truncate text-xs text-ink-muted">{track.artist}</span>
      </span>
      <span className="shrink-0 font-mono text-[11px] text-ink-faint tabular-nums">{plural(plays, "play")}</span>
    </motion.button>
  );
}

export function HomeView() {
  const history = useHistory((s) => s.history);
  const albums = useLibrary((s) => s.albums);
  const albumById = useLibrary((s) => s.albumById);
  const albumTracks = useLibrary((s) => s.albumTracks);
  const trackById = useLibrary((s) => s.trackById);
  const playlists = useLibrary((s) => s.playlists);
  const navigate = useUi((s) => s.navigate);

  const recent = useMemo(
    () => (history?.recentAlbums ?? []).map((id) => albumById.get(id)).filter((a): a is Album => a != null),
    [history, albumById],
  );
  const top = useMemo(
    () =>
      (history?.topTracks ?? [])
        .map(([id, n]) => ({ track: trackById.get(id), plays: n }))
        .filter((t): t is { track: Track; plays: number } => t.track != null)
        .slice(0, 8),
    [history, trackById],
  );
  const added = useMemo(() => {
    const newest = (id: number) => Math.max(...(albumTracks.get(id) ?? []).map((t) => t.addedAt));
    return albums
      .filter((a) => albumTracks.has(a.id))
      .sort((a, b) => newest(b.id) - newest(a.id))
      .slice(0, 12);
  }, [albums, albumTracks]);

  return (
    <div className="px-8 pb-16 pt-2">
      <h1 className="text-4xl font-semibold tracking-tight">Home</h1>
      {!recent.length && (
        <p className="mt-2 text-sm text-ink-muted">Play some music and your recent albums and favorites will show up here.</p>
      )}

      <div className="mt-6">
        {recent.length > 0 && <AlbumRow title="Jump back in" albums={recent} />}

        {top.length > 0 && (
          <Section title="On repeat">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {top.map((t, i) => (
                <SongTile key={t.track.id} track={t.track} plays={t.plays} index={i} all={top.map((x) => x.track.id)} />
              ))}
            </div>
          </Section>
        )}

        <AlbumRow title="Recently added" albums={added} />

        {playlists.length > 0 && (
          <Section title="Your playlists">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-5">
              {playlists.map((p) => {
                const tracks = p.trackIds.map((id) => trackById.get(id)).filter((t): t is Track => t != null);
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-drop={`playlist:${p.id}`}
                    onClick={() => navigate({ name: "playlist", id: p.id })}
                    className="group min-w-0 text-left"
                  >
                    <Mosaic
                      albums={albumCovers(tracks, albumById)}
                      className="aspect-square w-full shadow-[0_18px_40px_-18px_rgb(0_0_0/0.7)] transition-transform duration-300 ease-out-expo group-hover:-translate-y-1"
                    />
                    <span className="mt-3 block truncate text-sm font-medium">{p.name}</span>
                    <span className="block truncate text-xs text-ink-muted">{plural(tracks.length, "song")}</span>
                  </button>
                );
              })}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
