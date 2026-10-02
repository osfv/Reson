import { create } from "zustand";
import { api, type Lyrics } from "../lib/api";
import { parseLrc, type LyricLine } from "../lib/lrc";

export type LyricsEntry =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; lyrics: Lyrics; lines: LyricLine[] };

interface LyricsState {
  byTrack: Record<number, LyricsEntry>;
  load: (trackId: number, refresh?: boolean) => void;
  /** Replace a track's lyrics with a result we already have (manual pick, user sync). */
  put: (trackId: number, lyrics: Lyrics) => void;
  setOffset: (trackId: number, offsetMs: number) => void;
}

const ready = (lyrics: Lyrics): LyricsEntry => ({
  status: "ready",
  lyrics,
  lines: lyrics.synced ? parseLrc(lyrics.synced) : [],
});

export const useLyrics = create<LyricsState>((set, get) => ({
  byTrack: {},
  load: (trackId, refresh = false) => {
    const cur = get().byTrack[trackId];
    if (!refresh && cur && cur.status !== "error") return;
    set((s) => ({ byTrack: { ...s.byTrack, [trackId]: { status: "loading" } } }));
    api
      .lyrics(trackId, refresh)
      .then((lyrics) => set((s) => ({ byTrack: { ...s.byTrack, [trackId]: ready(lyrics) } })))
      .catch((e) => set((s) => ({ byTrack: { ...s.byTrack, [trackId]: { status: "error", error: String(e) } } })));
  },
  put: (trackId, lyrics) => set((s) => ({ byTrack: { ...s.byTrack, [trackId]: ready(lyrics) } })),
  setOffset: (trackId, offsetMs) => {
    const cur = get().byTrack[trackId];
    if (cur?.status !== "ready") return;
    set((s) => ({ byTrack: { ...s.byTrack, [trackId]: { ...cur, lyrics: { ...cur.lyrics, offsetMs } } } }));
    api.lyricsSetOffset(trackId, offsetMs).catch(() => {});
  },
}));
