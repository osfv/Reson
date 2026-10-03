import { invoke } from "@tauri-apps/api/core";

export interface Palette {
  bg: string;
  surface: string;
  accent: string;
  onAccent: string;
  /** Deep tones from the art for the Now Playing gradient. */
  swatches?: string[];
}

export interface Track {
  id: number;
  path: string;
  title: string;
  artist: string;
  albumId: number;
  trackNo: number | null;
  discNo: number | null;
  duration: number;
  genre: string | null;
  addedAt: number;
  /** Detected from the file's contents, e.g. "FLAC", "MP3", "AAC", "ALAC". */
  format: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  /** kbps */
  bitrate: number | null;
  channels: number | null;
  /** bytes */
  size: number | null;
}

export interface Album {
  id: number;
  title: string;
  artist: string;
  year: number | null;
  cover: string | null;
  palette: Palette | null;
}

export interface Playlist {
  id: number;
  name: string;
  createdAt: number;
  trackIds: number[];
}

export type SmartField =
  | "title"
  | "artist"
  | "album"
  | "albumArtist"
  | "genre"
  | "year"
  | "plays"
  | "lastPlayed"
  | "addedAt"
  | "duration"
  | "format"
  | "bitDepth"
  | "sampleRate"
  | "bitrate";

export type SmartOp =
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "lt"
  | "between"
  | "inLast"
  | "notInLast"
  | "before"
  | "after";

export interface SmartRule {
  field: SmartField;
  op: SmartOp;
  /** Text, a number, or [low, high] for "between". Days for inLast/notInLast, unix seconds for before/after. */
  value: string | number | [number, number];
}

export interface SmartRules {
  match: "all" | "any";
  rules: SmartRule[];
  limit: number | null;
  sort: { field: SmartField | "random"; desc: boolean; seed?: number } | null;
}

export interface SmartPlaylist {
  id: number;
  name: string;
  createdAt: number;
  rules: SmartRules;
  /** Evaluated by the backend from `rules`. */
  trackIds: number[];
}

export interface Library {
  tracks: Track[];
  albums: Album[];
  playlists: Playlist[];
  smartPlaylists: SmartPlaylist[];
}

export type Repeat = "off" | "all" | "one";

export interface QueueEntry {
  uid: number;
  id: number;
}

export interface PlayerSnapshot {
  queue: QueueEntry[];
  index: number | null;
  playing: boolean;
  volume: number;
  shuffle: boolean;
  repeat: Repeat;
  position: number;
  duration: number;
}

export interface ScanProgress {
  done: number;
  total: number;
  added: number;
  active: boolean;
  failed: number;
  failedNames: string[];
}

export interface Lyrics {
  /** LRC; may include `<mm:ss.xx>` word stamps for karaoke. */
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
  source: "file" | "embedded" | "lrclib" | "user" | "none";
  offsetMs: number;
}

export interface LyricsCandidate {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  synced: boolean;
  plain: boolean;
  instrumental: boolean;
  wordSync: boolean;
  preview: string;
}

export interface History {
  recentAlbums: number[];
  recentTracks: number[];
  topTracks: [number, number][];
}

export interface Prefs {
  /** Seconds; 0 means gapless. */
  crossfade: number;
  normalize: boolean;
  watchFolders: string[];
  closeToTray: boolean;
}

export interface Spectrum {
  bands: number[];
  bass: number;
  beat: boolean;
}

export const api = {
  lyrics: (trackId: number, refresh = false) => invoke<Lyrics>("lyrics_get", { trackId, refresh }),
  lyricsSearch: (query: string) => invoke<LyricsCandidate[]>("lyrics_search", { query }),
  lyricsChoose: (trackId: number, lrclibId: number) => invoke<Lyrics>("lyrics_choose", { trackId, lrclibId }),
  lyricsSetOffset: (trackId: number, offsetMs: number) => invoke<void>("lyrics_set_offset", { trackId, offsetMs }),
  lyricsSaveUser: (trackId: number, synced: string | null, plain: string | null, writeFile: boolean) =>
    invoke<Lyrics>("lyrics_save_user", { trackId, synced, plain, writeFile }),
  lyricsPublish: (trackId: number, synced: string, plain: string) =>
    invoke<void>("lyrics_publish", { trackId, synced, plain }),
  history: () => invoke<History>("history_get"),
  prefsGet: () => invoke<Prefs>("prefs_get"),
  prefsSet: (prefs: Prefs) => invoke<void>("prefs_set", { prefs }),
  visualizer: (on: boolean) => invoke<void>("visualizer_enable", { on }),
  miniPlayer: (open: boolean) => invoke<void>("mini_player", { open }),
  insert: (trackIds: number[], at: number) => invoke<void>("player_insert", { trackIds, at }),
  move: (uid: number, to: number) => invoke<void>("player_move", { uid, to }),
  library: () => invoke<Library>("get_library"),
  importPaths: (paths: string[]) => invoke<void>("import_paths", { paths }),
  removeTracks: (ids: number[]) => invoke<void>("remove_tracks", { ids }),

  playlistCreate: (name: string) => invoke<Playlist>("playlist_create", { name }),
  playlistRename: (id: number, name: string) => invoke<void>("playlist_rename", { id, name }),
  playlistDelete: (id: number) => invoke<void>("playlist_delete", { id }),
  playlistSetTracks: (id: number, trackIds: number[]) => invoke<void>("playlist_set_tracks", { id, trackIds }),
  playlistAddTracks: (id: number, trackIds: number[]) => invoke<void>("playlist_add_tracks", { id, trackIds }),

  smartPlaylists: () => invoke<SmartPlaylist[]>("smart_playlists_get"),
  smartPreview: (rules: SmartRules) => invoke<number[]>("smart_preview", { rules }),
  smartCreate: (name: string, rules: SmartRules) => invoke<SmartPlaylist>("smart_create", { name, rules }),
  smartUpdate: (id: number, name: string, rules: SmartRules) => invoke<void>("smart_update", { id, name, rules }),
  smartDelete: (id: number) => invoke<void>("smart_delete", { id }),
  smartAddDefaults: () => invoke<SmartPlaylist[]>("smart_add_defaults"),

  playerState: () => invoke<PlayerSnapshot>("player_state"),
  play: (trackIds: number[], index = 0) => invoke<void>("player_play", { trackIds, index }),
  enqueue: (trackIds: number[], next: boolean) => invoke<void>("player_enqueue", { trackIds, next }),
  toggle: () => invoke<void>("player_toggle"),
  next: () => invoke<void>("player_next"),
  prev: () => invoke<void>("player_prev"),
  seek: (position: number) => invoke<void>("player_seek", { position }),
  setVolume: (volume: number) => invoke<void>("player_set_volume", { volume }),
  setShuffle: (on: boolean) => invoke<void>("player_set_shuffle", { on }),
  setRepeat: (mode: Repeat) => invoke<void>("player_set_repeat", { mode }),
  jump: (uid: number) => invoke<void>("player_jump", { uid }),
  removeFromQueue: (uid: number) => invoke<void>("player_remove", { uid }),
  clearUpcoming: () => invoke<void>("player_clear_upcoming"),
};
