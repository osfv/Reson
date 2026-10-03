import { open } from "@tauri-apps/plugin-dialog";
import { api, type SmartRules } from "./api";
import { useLibrary } from "../store/library";
import { watchFolders } from "../store/prefs";
import { useUi, type MenuItem } from "../store/ui";
import { plural } from "./format";

const AUDIO_EXTS = ["mp3", "flac", "m4a", "mp4", "aac", "ogg", "oga", "wav"];

const fail = (e: unknown) => useUi.getState().toast(String(e));

export function playTracks(ids: number[], index = 0) {
  if (ids.length) api.play(ids, index).catch(fail);
}

export function shuffleTracks(ids: number[]) {
  if (!ids.length) return;
  api
    .setShuffle(true)
    .then(() => api.play(ids, Math.floor(Math.random() * ids.length)))
    .catch(fail);
}

export function enqueue(ids: number[], next: boolean) {
  api
    .enqueue(ids, next)
    .then(() => useUi.getState().toast(next ? "Playing next" : `Added ${plural(ids.length, "song")} to queue`))
    .catch(fail);
}

export async function importFolders() {
  const picked = await open({ directory: true, multiple: true, title: "Add music folders" });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (!paths.length) return;
  // Folders you add are watched, so new downloads show up without importing again.
  watchFolders(paths);
  await api.importPaths(paths).catch(fail);
}

export async function importFiles() {
  const picked = await open({
    multiple: true,
    title: "Add music files",
    filters: [{ name: "Audio", extensions: AUDIO_EXTS }],
  });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (paths.length) await api.importPaths(paths).catch(fail);
}

export async function createPlaylist(trackIds: number[] = []) {
  const count = useLibrary.getState().playlists.length;
  try {
    const pl = await api.playlistCreate(`Playlist ${count + 1}`);
    if (trackIds.length) await api.playlistAddTracks(pl.id, trackIds);
    useLibrary.getState().setPlaylists((ps) => [...ps, { ...pl, trackIds }]);
    useUi.getState().navigate({ name: "playlist", id: pl.id, rename: true });
  } catch (e) {
    fail(e);
  }
}

export function addToPlaylist(id: number, trackIds: number[]) {
  const pl = useLibrary.getState().playlists.find((p) => p.id === id);
  useLibrary.getState().setPlaylists((ps) =>
    ps.map((p) => (p.id === id ? { ...p, trackIds: [...p.trackIds, ...trackIds] } : p)),
  );
  api
    .playlistAddTracks(id, trackIds)
    .then(() => useUi.getState().toast(`Added to ${pl?.name ?? "playlist"}`))
    .catch(fail);
}

export function setPlaylistTracks(id: number, trackIds: number[]) {
  useLibrary.getState().setPlaylists((ps) => ps.map((p) => (p.id === id ? { ...p, trackIds } : p)));
  api.playlistSetTracks(id, trackIds).catch(fail);
}

export function renamePlaylist(id: number, name: string) {
  const clean = name.trim();
  if (!clean) return;
  useLibrary.getState().setPlaylists((ps) => ps.map((p) => (p.id === id ? { ...p, name: clean } : p)));
  api.playlistRename(id, clean).catch(fail);
}

export function deletePlaylist(id: number) {
  useLibrary.getState().setPlaylists((ps) => ps.filter((p) => p.id !== id));
  const ui = useUi.getState();
  if (ui.route.name === "playlist" && ui.route.id === id) ui.navigate({ name: "albums" });
  api.playlistDelete(id).catch(fail);
}

export async function saveSmartPlaylist(id: number | null, name: string, rules: SmartRules) {
  const clean = name.trim() || "Smart playlist";
  const lib = useLibrary.getState();
  try {
    if (id == null) {
      const pl = await api.smartCreate(clean, rules);
      lib.setSmartPlaylists([...useLibrary.getState().smartPlaylists, pl]);
      useUi.getState().navigate({ name: "smart", id: pl.id });
    } else {
      await api.smartUpdate(id, clean, rules);
      lib.refreshSmart();
    }
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export function deleteSmartPlaylist(id: number) {
  const lib = useLibrary.getState();
  lib.setSmartPlaylists(lib.smartPlaylists.filter((p) => p.id !== id));
  const ui = useUi.getState();
  if (ui.route.name === "smart" && ui.route.id === id) ui.navigate({ name: "albums" });
  api.smartDelete(id).catch(fail);
}

export function smartPlaylistMenu(id: number): MenuItem[] {
  return [
    { label: "Edit rules", onSelect: () => useUi.getState().editSmart(id) },
    { label: "Delete smart playlist", danger: true, onSelect: () => deleteSmartPlaylist(id) },
  ];
}

/** Opt-in: adds Most played, Recently added and the other suggestions the user doesn't have yet. */
export async function addSuggestedSmartPlaylists() {
  const before = useLibrary.getState().smartPlaylists.length;
  try {
    const list = await api.smartAddDefaults();
    useLibrary.getState().setSmartPlaylists(list);
    const added = list.length - before;
    useUi.getState().toast(added ? `Added ${plural(added, "smart playlist")}` : "You already have all the suggestions");
  } catch (e) {
    fail(e);
  }
}

export async function removeFromLibrary(ids: number[]) {
  try {
    await api.removeTracks(ids);
    useUi.getState().toast(`Removed ${plural(ids.length, "song")} from your library`);
  } catch (e) {
    fail(e);
  }
}

/** Context menu for one or more tracks. `playlist` adds playlist-specific entries. */
export function trackMenu(ids: number[], opts: { playlistId?: number; positions?: number[] } = {}): MenuItem[] {
  const { playlists, trackById, albumById } = useLibrary.getState();
  const { navigate } = useUi.getState();
  const single = ids.length === 1 ? trackById.get(ids[0]) : undefined;
  const album = single ? albumById.get(single.albumId) : undefined;

  const items: MenuItem[] = [
    { label: "Play next", onSelect: () => enqueue(ids, true) },
    { label: "Add to queue", onSelect: () => enqueue(ids, false) },
    {
      label: "Add to playlist",
      submenu: [
        { label: "New playlist", onSelect: () => createPlaylist(ids) },
        ...(playlists.length ? [{ label: "", separator: true }] : []),
        ...playlists
          .filter((p) => p.id !== opts.playlistId)
          .map((p) => ({ label: p.name, onSelect: () => addToPlaylist(p.id, ids) })),
      ],
    },
  ];
  if (single && album) {
    items.push(
      { label: "", separator: true },
      { label: "Go to album", onSelect: () => navigate({ name: "album", id: album.id }) },
      { label: "Go to artist", onSelect: () => navigate({ name: "artist", artist: album.artist }) },
      { label: "Song info", onSelect: () => useUi.getState().showInfo(single.id) },
    );
  }
  if (opts.playlistId != null && opts.positions) {
    const pid = opts.playlistId;
    const drop = new Set(opts.positions);
    items.push(
      { label: "", separator: true },
      {
        label: "Remove from this playlist",
        onSelect: () => {
          const pl = useLibrary.getState().playlists.find((p) => p.id === pid);
          if (pl) setPlaylistTracks(pid, pl.trackIds.filter((_, i) => !drop.has(i)));
        },
      },
    );
  }
  items.push(
    { label: "", separator: true },
    {
      label: ids.length > 1 ? `Remove ${ids.length} songs from library` : "Remove from library",
      danger: true,
      onSelect: () => removeFromLibrary(ids),
    },
  );
  return items;
}
