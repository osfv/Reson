import { create } from "zustand";
import type { PlayerSnapshot } from "../lib/api";
import { clock, nudgeClock, setClock } from "../lib/clock";
import { useLibrary } from "./library";

interface PlayerState extends PlayerSnapshot {
  setSnapshot: (s: PlayerSnapshot) => void;
  setProgress: (position: number, duration: number) => void;
  /** Optimistic seek: move the UI immediately, before the engine confirms. */
  seekLocal: (position: number) => void;
}

const currentUid = (s: { queue: PlayerSnapshot["queue"]; index: number | null }) =>
  s.index != null ? s.queue[s.index]?.uid : undefined;

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  index: null,
  playing: false,
  volume: 0.8,
  shuffle: false,
  repeat: "off",
  position: 0,
  duration: 0,
  output: null,
  setSnapshot: (s) => {
    const prev = get();
    const jumped =
      currentUid(prev) !== currentUid(s) || prev.playing !== s.playing || Math.abs(clock.get() - s.position) > 0.6;
    if (jumped) setClock(s.position, s.duration, s.playing);
    else nudgeClock(s.position, s.duration);
    set(s);
  },
  setProgress: (position, duration) => {
    nudgeClock(position, duration);
    set({ position, duration });
  },
  seekLocal: (position) => {
    setClock(position, get().duration, get().playing);
    set({ position });
  },
}));

export function useCurrentTrack() {
  const id = usePlayer((s) => (s.index != null ? s.queue[s.index]?.id : undefined));
  const track = useLibrary((s) => (id != null ? s.trackById.get(id) : undefined));
  const album = useLibrary((s) => (track ? s.albumById.get(track.albumId) : undefined));
  return { track, album };
}
