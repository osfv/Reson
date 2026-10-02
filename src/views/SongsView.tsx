import { useMemo, useState } from "react";
import { Shuffle } from "@phosphor-icons/react";
import { PlayButton, IconButton } from "../components/Buttons";
import { PageHeader, SortPills } from "../components/PageHeader";
import { TrackList } from "../components/TrackList";
import { playTracks, shuffleTracks } from "../lib/actions";
import { formatTotal, plural } from "../lib/format";
import { useLibrary } from "../store/library";

type Sort = "artist" | "title" | "recent";

export function SongsView() {
  const tracks = useLibrary((s) => s.tracks);
  const [sort, setSort] = useState<Sort>("artist");

  const sorted = useMemo(() => {
    if (sort === "artist") return tracks;
    const list = [...tracks];
    if (sort === "title") return list.sort((a, b) => a.title.localeCompare(b.title));
    return list.sort((a, b) => b.addedAt - a.addedAt || b.id - a.id);
  }, [tracks, sort]);

  const total = useMemo(() => tracks.reduce((s, t) => s + t.duration, 0), [tracks]);
  const ids = () => sorted.map((t) => t.id);

  return (
    <div className="pb-16">
      <PageHeader title="Songs" meta={`${plural(tracks.length, "song")}, ${formatTotal(total)}`}>
        <SortPills
          value={sort}
          onChange={setSort}
          options={[
            { value: "artist", label: "Artist" },
            { value: "title", label: "Title" },
            { value: "recent", label: "Recently added" },
          ]}
        />
      </PageHeader>
      <div className="flex items-center gap-3 px-8 pb-6">
        <PlayButton playing={false} label="Play all songs" onClick={() => playTracks(ids())} size={52} />
        <IconButton label="Shuffle all songs" onClick={() => shuffleTracks(ids())} className="h-11 w-11">
          <Shuffle size={22} />
        </IconButton>
      </div>
      <TrackList tracks={sorted} />
    </div>
  );
}
