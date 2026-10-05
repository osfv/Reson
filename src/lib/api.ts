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
  /** Spectral check of lossless files: null = not yet, -1 = couldn't tell, 0 = full band,
   * otherwise the frequency (Hz) where the audio stops. */
  cutoffHz: number | null;
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

export interface Library {
  tracks: Track[];
  albums: Album[];
  playlists: Playlist[];
  /** Liked track ids, most recent first. */
  liked: number[];
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
  /** Set while playing through WASAPI exclusive mode. */
  output: OutputStatus | null;
}

export interface OutputStatus {
  exclusive: boolean;
  rate: number;
  bits: number;
  bitPerfect: boolean;
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

export type FilterKind = "peak" | "lowShelf" | "highShelf";

export interface EqFilter {
  kind: FilterKind;
  freq: number;
  /** dB */
  gain: number;
  q: number;
}

export interface EqProfile {
  name: string;
  preamp: number;
  filters: EqFilter[];
}

export interface EqSettings {
  enabled: boolean;
  /** dB for each of EQ_FREQS. */
  bands: number[];
  preamp: number;
  profile: EqProfile | null;
}

export interface Prefs {
  /** Seconds; 0 means gapless. */
  crossfade: number;
  normalize: boolean;
  watchFolders: string[];
  closeToTray: boolean;
  eq: EqSettings;
  /** Endpoint id; null follows the Windows default. */
  outputDevice: string | null;
  exclusive: boolean;
  discord: boolean;
  /** The user's own Discord application id. */
  discordAppId: string | null;
  discordCovers: boolean;
  autoUpdate: boolean;
}

export interface AudioDevice {
  id: string;
  name: string;
  default: boolean;
}

export interface YearStats {
  year: number;
  years: number[];
  plays: number;
  minutes: number;
  songs: number;
  artists: number;
  albums: number;
  /** [track id, plays, minutes] */
  topTracks: [number, number, number][];
  /** [album id, plays, minutes] */
  topAlbums: [number, number, number][];
  /** [album artist, plays, minutes] */
  topArtists: [string, number, number][];
  topGenres: [string, number][];
  /** Minutes per month, January first. */
  months: number[];
  topDay: [string, number] | null;
  longestStreak: number;
  firstTrack: [number, string] | null;
  liked: number;
  newSongs: number;
}

export interface LastFmStatus {
  /** The user has entered their own API key and secret. */
  configured: boolean;
  /** Last four characters of the API key in use. */
  keyHint: string | null;
  user: string | null;
}

export interface UpdateInfo {
  version: string;
  current: string;
  notes: string;
  date: string | null;
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

  setLiked: (trackId: number, liked: boolean) => invoke<void>("set_liked", { trackId, liked }),
  audioDevices: () => invoke<AudioDevice[]>("audio_devices"),
  yearStats: (year: number) => invoke<YearStats>("year_stats", { year }),
  coverBytes: (albumId: number) => invoke<ArrayBuffer>("cover_bytes", { albumId }),
  /** Opens a save dialog and writes the PNG. Resolves false if the user cancels. */
  saveImage: (png: Uint8Array, fileName: string) =>
    invoke<boolean>("save_image", png, { headers: { "x-file-name": fileName } }),
  openLink: (url: string) => invoke<void>("open_link", { url }),
  lastfmStatus: () => invoke<LastFmStatus>("lastfm_status"),
  /** Resolves with the user name once approved in the browser, or null on timeout. */
  lastfmConnect: () => invoke<string | null>("lastfm_connect"),
  lastfmDisconnect: () => invoke<void>("lastfm_disconnect"),
  lastfmSetKeys: (key: string, secret: string) => invoke<void>("lastfm_set_keys", { key, secret }),
  lastfmClearKeys: () => invoke<void>("lastfm_clear_keys"),
  /** Resolves with the Discord user name if the id works with the running Discord app. */
  discordTest: (appId: string) => invoke<string>("discord_test", { appId }),
  updateCheck: () => invoke<UpdateInfo | null>("update_check"),
  updateInstall: () => invoke<void>("update_install"),
};
