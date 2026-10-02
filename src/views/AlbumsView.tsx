import { useMemo, useState } from "react";
import { AlbumGrid } from "../components/AlbumGrid";
import { PageHeader, SortPills } from "../components/PageHeader";
import { plural } from "../lib/format";
import { useLibrary } from "../store/library";

type Sort = "title" | "artist" | "recent" | "year";

export function AlbumsView() {
  const albums = useLibrary((s) => s.albums);
  const albumTracks = useLibrary((s) => s.albumTracks);
  const [sort, setSort] = useState<Sort>("recent");

  const sorted = useMemo(() => {
    const list = albums.filter((a) => albumTracks.has(a.id));
    const added = (id: number) => Math.max(...(albumTracks.get(id) ?? []).map((t) => t.addedAt));
    switch (sort) {
      case "title":
        return list.sort((a, b) => a.title.localeCompare(b.title));
      case "artist":
        return list.sort((a, b) => a.artist.localeCompare(b.artist) || (a.year ?? 0) - (b.year ?? 0));
      case "year":
        return list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));
      case "recent":
        return list.sort((a, b) => added(b.id) - added(a.id) || b.id - a.id);
    }
  }, [albums, albumTracks, sort]);

  return (
    <div className="pb-16">
      <PageHeader title="Albums" meta={plural(sorted.length, "album")}>
        <SortPills
          value={sort}
          onChange={setSort}
          options={[
            { value: "recent", label: "Recently added" },
            { value: "title", label: "Title" },
            { value: "artist", label: "Artist" },
            { value: "year", label: "Year" },
          ]}
        />
      </PageHeader>
      <div className="px-8">
        <AlbumGrid albums={sorted} />
      </div>
    </div>
  );
}
