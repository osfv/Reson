import { useMemo } from "react";
import { DotsThree, Shuffle, Sparkle } from "@phosphor-icons/react";
import { IconButton, PillButton, PlayButton } from "../components/Buttons";
import { Mosaic } from "../components/Cover";
import { TrackList } from "../components/TrackList";
import { api, type Track } from "../lib/api";
import { enqueue, playTracks, shuffleTracks, smartPlaylistMenu } from "../lib/actions";
import { formatTotal, plural } from "../lib/format";
import { describeRules } from "../lib/smart";
import { albumCovers, useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { NotFound } from "./NotFound";

export function SmartPlaylistView({ id }: { id: number }) {
  const playlist = useLibrary((s) => s.smartPlaylists.find((p) => p.id === id));
  const trackById = useLibrary((s) => s.trackById);
  const albumById = useLibrary((s) => s.albumById);
  const editSmart = useUi((s) => s.editSmart);
  const openMenu = useUi((s) => s.openMenu);

  const tracks = useMemo(
    () => (playlist?.trackIds ?? []).map((tid) => trackById.get(tid)).filter((t): t is Track => t != null),
    [playlist, trackById],
  );
  const playingHere = usePlayer((s) => {
    const cur = s.index != null ? s.queue[s.index]?.id : undefined;
    return s.playing && cur != null && playlist?.trackIds.includes(cur) === true;
  });

  if (!playlist) return <NotFound what="playlist" />;
  const ids = tracks.map((t) => t.id);
  const total = tracks.reduce((s, t) => s + t.duration, 0);

  return (
    <div className="relative pb-16">
      <header className="flex flex-col gap-8 px-8 pb-8 pt-2 md:flex-row md:items-end">
        <Mosaic albums={albumCovers(tracks, albumById)} className="h-56 w-56 shadow-[0_28px_60px_-20px_rgb(0_0_0/0.75)] lg:h-60 lg:w-60" />
        <div className="min-w-0 flex-1">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-accent">
            <Sparkle size={14} weight="fill" />
            Smart playlist
          </p>
          <h1 className="truncate pb-1 text-4xl font-semibold leading-[1.08] tracking-tight lg:text-5xl">{playlist.name}</h1>
          <p className="mt-3 max-w-[70ch] text-sm leading-relaxed text-ink-muted">{describeRules(playlist.rules)}</p>
          <p className="mt-1 text-sm text-ink-muted">
            {tracks.length ? `${plural(tracks.length, "song")}, ${formatTotal(total)}` : "No matching songs"}
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
        <PillButton onClick={() => editSmart(playlist.id)}>Edit rules</PillButton>
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
              ...smartPlaylistMenu(playlist.id),
            ]);
          }}
        >
          <DotsThree size={24} weight="bold" />
        </IconButton>
      </div>

      {tracks.length ? (
        <TrackList tracks={tracks} />
      ) : (
        <div className="mx-8 rounded-2xl bg-white/[0.03] px-8 py-10">
          <h2 className="text-lg font-semibold tracking-tight">Nothing matches yet</h2>
          <p className="mt-1.5 max-w-[56ch] text-sm leading-relaxed text-ink-muted">
            Songs show up here on their own as soon as they match the rules. Try loosening a rule to see more.
          </p>
          <PillButton className="mt-5" onClick={() => editSmart(playlist.id)}>
            Edit rules
          </PillButton>
        </div>
      )}
    </div>
  );
}
