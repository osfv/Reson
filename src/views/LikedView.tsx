import { useMemo } from "react";
import { Heart, Shuffle } from "@phosphor-icons/react";
import { IconButton, PillButton, PlayButton } from "../components/Buttons";
import { TrackList } from "../components/TrackList";
import { api, type Track } from "../lib/api";
import { playTracks, shuffleTracks } from "../lib/actions";
import { formatTotal, plural } from "../lib/format";
import { useLibrary } from "../store/library";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";

export function LikedView() {
  const liked = useLibrary((s) => s.liked);
  const trackById = useLibrary((s) => s.trackById);
  const navigate = useUi((s) => s.navigate);
  const tracks = useMemo(() => liked.map((id) => trackById.get(id)).filter((t): t is Track => t != null), [liked, trackById]);
  const ids = tracks.map((t) => t.id);
  const playingHere = usePlayer((s) => {
    const cur = s.index != null ? s.queue[s.index]?.id : undefined;
    return s.playing && cur != null && liked.includes(cur);
  });
  const total = tracks.reduce((s, t) => s + t.duration, 0);

  return (
    <div className="relative pb-16">
      <header className="flex flex-col gap-8 px-8 pb-8 pt-2 md:flex-row md:items-end">
        <div className="liked-tile grid h-56 w-56 shrink-0 place-items-center rounded-xl text-white shadow-[0_28px_60px_-20px_rgb(0_0_0/0.75)] lg:h-60 lg:w-60">
          <Heart size={88} weight="fill" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="pb-1 text-4xl font-semibold leading-[1.08] tracking-tight lg:text-5xl">Liked songs</h1>
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
        <IconButton label="Shuffle liked songs" onClick={() => shuffleTracks(ids)} disabled={!tracks.length} className="h-11 w-11">
          <Shuffle size={22} />
        </IconButton>
      </div>

      {tracks.length ? (
        <TrackList tracks={tracks} />
      ) : (
        <div className="mx-8 rounded-2xl bg-white/[0.03] px-8 py-10">
          <h2 className="text-lg font-semibold tracking-tight">Songs you like will show up here</h2>
          <p className="mt-1.5 max-w-[56ch] text-sm leading-relaxed text-ink-muted">
            Tap the heart next to any song, in the player bar or in Now Playing. You can also drag songs onto Liked songs in
            the sidebar.
          </p>
          <PillButton className="mt-5" onClick={() => navigate({ name: "songs" })}>
            Browse songs
          </PillButton>
        </div>
      )}
    </div>
  );
}
