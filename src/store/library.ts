import { create } from "zustand";
import { api, type Album, type Library, type Playlist, type ScanProgress, type SmartPlaylist, type Track } from "../lib/api";

export interface Artist {
  name: string;
  albums: Album[];
  tracks: Track[];
}

interface LibraryState {
  loaded: boolean;
  error: string | null;
  tracks: Track[];
  albums: Album[];
  playlists: Playlist[];
  smartPlaylists: SmartPlaylist[];
  trackById: Map<number, Track>;
  albumById: Map<number, Album>;
  albumTracks: Map<number, Track[]>;
  artists: Artist[];
  artistByName: Map<string, Artist>;
  scan: ScanProgress | null;
  refresh: () => Promise<void>;
  setScan: (scan: ScanProgress) => void;
  setPlaylists: (fn: (p: Playlist[]) => Playlist[]) => void;
  setSmartPlaylists: (list: SmartPlaylist[]) => void;
  /** Re-evaluates smart playlists only, e.g. after a play changes play counts. */
  refreshSmart: () => void;
}

const byDiscTrack = (a: Track, b: Track) =>
  (a.discNo ?? 1) - (b.discNo ?? 1) || (a.trackNo ?? 1e6) - (b.trackNo ?? 1e6) || a.title.localeCompare(b.title);

function index(lib: Library) {
  const trackById = new Map(lib.tracks.map((t) => [t.id, t]));
  const albumById = new Map(lib.albums.map((a) => [a.id, a]));
  const albumTracks = new Map<number, Track[]>();
  for (const t of lib.tracks) {
    const list = albumTracks.get(t.albumId);
    if (list) list.push(t);
    else albumTracks.set(t.albumId, [t]);
  }
  for (const list of albumTracks.values()) list.sort(byDiscTrack);

  const artistByName = new Map<string, Artist>();
  const artistOf = (name: string) => {
    let a = artistByName.get(name);
    if (!a) artistByName.set(name, (a = { name, albums: [], tracks: [] }));
    return a;
  };
  for (const album of lib.albums) artistOf(album.artist).albums.push(album);
  for (const t of lib.tracks) {
    const albumArtist = albumById.get(t.albumId)?.artist;
    artistOf(albumArtist ?? t.artist).tracks.push(t);
  }
  for (const a of artistByName.values()) a.albums.sort((x, y) => (y.year ?? 0) - (x.year ?? 0));
  const artists = [...artistByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { trackById, albumById, albumTracks, artists, artistByName };
}

export const useLibrary = create<LibraryState>((set) => ({
  loaded: false,
  error: null,
  tracks: [],
  albums: [],
  playlists: [],
  smartPlaylists: [],
  trackById: new Map(),
  albumById: new Map(),
  albumTracks: new Map(),
  artists: [],
  artistByName: new Map(),
  scan: null,
  refresh: async () => {
    try {
      const lib = await api.library();
      set({ loaded: true, error: null, tracks: lib.tracks, albums: lib.albums, playlists: lib.playlists, smartPlaylists: lib.smartPlaylists, ...index(lib) });
    } catch (e) {
      set({ loaded: true, error: String(e) });
    }
  },
  setScan: (scan) => set({ scan }),
  setPlaylists: (fn) => set((s) => ({ playlists: fn(s.playlists) })),
  setSmartPlaylists: (smartPlaylists) => set({ smartPlaylists }),
  refreshSmart: () => {
    api
      .smartPlaylists()
      .then((smartPlaylists) => set({ smartPlaylists }))
      .catch(() => {});
  },
}));

export const albumCovers = (tracks: Track[], albumById: Map<number, Album>, max = 4): Album[] => {
  const seen = new Set<number>();
  const out: Album[] = [];
  for (const t of tracks) {
    if (seen.has(t.albumId)) continue;
    seen.add(t.albumId);
    const a = albumById.get(t.albumId);
    if (a?.cover) out.push(a);
    if (out.length === max) break;
  }
  return out;
};
