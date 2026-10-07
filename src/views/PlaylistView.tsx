import { useEffect, useMemo, useRef, useState } from "react";
import { DotsThree, PencilSimple, Shuffle } from "@phosphor-icons/react";
import { IconButton, PillButton, PlayButton } from "../components/Buttons";
import { Mosaic } from "../components/Cover";
import { TrackList } from "../components/TrackList";
import { api, type Track } from "../lib/api";
import { deletePlaylist, enqueue, playTracks, renamePlaylist, setPlaylistTracks, shuffleTracks } from "../lib/actions";
import { formatTotal, plural } from "../lib/format";
import { albumCovers, useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { NotFound } from "./NotFound";

function TitleEditor({ id, name, startEditing }: { id: number; name: string; startEditing?: boolean }) {
  const [editing, setEditing] = useState(!!startEditing);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  useEffect(() => {
    setDraft(name);
  }, [name]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== name) renamePlaylist(id, draft);
    else setDraft(name);
  };

  if (editing) {
    return (
      <label className="block">
        <span className="sr-only">Playlist name</span>
        <input
          ref={input}
          value={draft}
          maxLength={100}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(name);
              setEditing(false);
            }
            e.stopPropagation();
          }}
          className="w-full rounded-md bg-white/[0.07] px-2 py-1 text-4xl font-semibold tracking-tight text-ink outline-none ring-1 ring-white/20 focus:ring-accent lg:text-5xl"
        />
      </label>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename playlist"
      className="group flex max-w-full items-center gap-3 text-left"
    >
      <h1 className="truncate pb-1 text-4xl font-semibold leading-[1.08] tracking-tight lg:text-5xl">{name}</h1>
      <PencilSimple size={20} className="shrink-0 text-ink-muted opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

export function PlaylistView({ id, rename }: { id: number; rename?: boolean }) {
  const playlist = useLibrary((s) => s.playlists.find((p) => p.id === id));
  const trackById = useLibrary((s) => s.trackById);
  const albumById = useLibrary((s) => s.albumById);
  const navigate = useUi((s) => s.navigate);
  const openMenu = useUi((s) => s.openMenu);

  // Hidden (missing) tracks stay in the playlist, so visible rows map back to their real positions.
  const { tracks, positions } = useMemo(() => {
    const tracks: Track[] = [];
    const positions: number[] = [];
    (playlist?.trackIds ?? []).forEach((tid, pos) => {
      const t = trackById.get(tid);
      if (t) {
        tracks.push(t);
        positions.push(pos);
      }
    });
    return { tracks, positions };
  }, [playlist, trackById]);
  const playingHere = usePlayer((s) => {
    const cur = s.index != null ? s.queue[s.index]?.id : undefined;
    return s.playing && cur != null && playlist?.trackIds.includes(cur) === true;
  });

  if (!playlist) return <NotFound what="playlist" />;
  const ids = tracks.map((t) => t.id);
  const total = tracks.reduce((s, t) => s + t.duration, 0);

  const move = (from: number, to: number) => {
    const next = [...playlist.trackIds];
    const [item] = next.splice(positions[from], 1);
    next.splice(positions[to], 0, item);
    setPlaylistTracks(playlist.id, next);
  };

  return (
    <div className="relative pb-16">
      <header className="flex flex-col gap-8 px-8 pb-8 pt-2 md:flex-row md:items-end">
        <Mosaic albums={albumCovers(tracks, albumById)} className="h-56 w-56 shadow-[0_28px_60px_-20px_rgb(0_0_0/0.75)] lg:h-60 lg:w-60" />
        <div className="min-w-0 flex-1">
          <TitleEditor key={playlist.id} id={playlist.id} name={playlist.name} startEditing={rename} />
          <p className="mt-3 text-sm text-ink-muted">
            {tracks.length ? `${plural(tracks.length, "song")}, ${formatTotal(total)}` : "No songs yet"}
          </p>
        </div>
      </header>

      <div className="flex items-center gap-3 px-8 pb-6">
        <PlayButton
          playing={playingHere}
          onClick={() => (playingHere ? api.toggle() : playTracks(ids))}
          size={56}
          className={tracks.length ? undefined : "pointer-events-none opacity-40"}
        />
        <IconButton label="Shuffle playlist" onClick={() => shuffleTracks(ids)} disabled={!tracks.length} className="h-11 w-11">
          <Shuffle size={22} />
        </IconButton>
        <IconButton
          label="More options"
          className="h-11 w-11"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.bottom + 6, [
              ...(tracks.length
                ? [
                    { label: "Add to queue", onSelect: () => enqueue(ids, false) },
                    { label: "", separator: true },
                  ]
                : []),
              { label: "Delete playlist", danger: true, onSelect: () => deletePlaylist(playlist.id) },
            ]);
          }}
        >
          <DotsThree size={24} weight="bold" />
        </IconButton>
      </div>

      {tracks.length ? (
        <TrackList tracks={tracks} playlistId={playlist.id} positions={positions} onMove={move} />
      ) : (
        <div className="mx-8 rounded-2xl bg-white/[0.03] px-8 py-10">
          <h2 className="text-lg font-semibold tracking-tight">Start filling this playlist</h2>
          <p className="mt-1.5 max-w-[56ch] text-sm leading-relaxed text-ink-muted">
            Right-click any song or album and choose Add to playlist. Drag songs here afterwards to reorder them.
          </p>
          <PillButton className="mt-5" onClick={() => navigate({ name: "songs" })}>
            Browse songs
          </PillButton>
        </div>
      )}
    </div>
  );
}
