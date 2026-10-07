import { create } from "zustand";
import { api, type LastFmStatus, type UpdateInfo } from "../lib/api";

interface SystemState {
  /** A newer release, if the last check found one. */
  update: UpdateInfo | null;
  /** Download progress while installing an update. */
  installing: { downloaded: number; total: number | null } | null;
  /** Hides the sidebar update card until the next launch. */
  updateDismissed: boolean;
  lastfm: LastFmStatus | null;
  setUpdate: (u: UpdateInfo | null) => void;
  refreshLastfm: () => Promise<void>;
  install: () => Promise<void>;
}

export const useSystem = create<SystemState>((set) => ({
  update: null,
  installing: null,
  updateDismissed: false,
  lastfm: null,
  setUpdate: (update) => set({ update }),
  refreshLastfm: async () => {
    set({ lastfm: await api.lastfmStatus() });
  },
  install: async () => {
    set({ installing: { downloaded: 0, total: null } });
    try {
      // Reson quits once the installer starts, and the installer reopens it.
      await api.updateInstall();
    } catch (e) {
      set({ installing: null });
      throw e;
    }
  },
}));
