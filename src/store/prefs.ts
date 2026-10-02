import { create } from "zustand";
import { api, type Prefs } from "../lib/api";

/** Preferences that only affect the UI, kept in localStorage. */
export interface UiPrefs {
  karaoke: boolean;
  barLyrics: boolean;
  /** Spectrum bars along the bottom of Now Playing. */
  visualizer: boolean;
  /** Cover and backdrop pulse with the beat. */
  beatPulse: boolean;
}

const UI_KEY = "reson.uiPrefs";
const UI_DEFAULTS: UiPrefs = { karaoke: true, barLyrics: true, visualizer: true, beatPulse: true };

function loadUi(): UiPrefs {
  try {
    return { ...UI_DEFAULTS, ...JSON.parse(localStorage.getItem(UI_KEY) ?? "{}") };
  } catch {
    return UI_DEFAULTS;
  }
}

interface PrefsState {
  prefs: Prefs | null;
  ui: UiPrefs;
  load: () => Promise<void>;
  set: (patch: Partial<Prefs>) => void;
  setUi: (patch: Partial<UiPrefs>) => void;
}

export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: null,
  ui: loadUi(),
  load: async () => {
    set({ prefs: await api.prefsGet() });
  },
  set: (patch) => {
    const cur = get().prefs;
    if (!cur) return;
    const next = { ...cur, ...patch };
    set({ prefs: next });
    api.prefsSet(next);
  },
  setUi: (patch) => {
    const next = { ...get().ui, ...patch };
    localStorage.setItem(UI_KEY, JSON.stringify(next));
    set({ ui: next });
  },
}));

/** Adds folders to the watch list (deduplicated). */
export function watchFolders(paths: string[]) {
  const { prefs, set } = usePrefs.getState();
  if (!prefs) return;
  const merged = [...prefs.watchFolders];
  for (const p of paths) if (!merged.some((m) => m.toLowerCase() === p.toLowerCase())) merged.push(p);
  if (merged.length !== prefs.watchFolders.length) set({ watchFolders: merged });
}
