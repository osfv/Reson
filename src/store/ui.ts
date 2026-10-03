import { create } from "zustand";

export type Route =
  | { name: "home" }
  | { name: "settings" }
  | { name: "songs" }
  | { name: "albums" }
  | { name: "artists" }
  | { name: "album"; id: number }
  | { name: "artist"; artist: string }
  | { name: "playlist"; id: number; rename?: boolean }
  | { name: "smart"; id: number }
  | { name: "search" };

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  submenu?: MenuItem[];
  danger?: boolean;
  separator?: boolean;
}

interface Toast {
  id: number;
  message: string;
}

interface UiState {
  route: Route;
  back: Route[];
  forward: Route[];
  query: string;
  queueOpen: boolean;
  nowPlaying: boolean;
  menu: { x: number; y: number; items: MenuItem[] } | null;
  /** Track id whose file details are shown in the Song info dialog. */
  info: number | null;
  /** Now Playing shows lyrics instead of the up-next list. Remembered across launches. */
  lyrics: boolean;
  toggleLyrics: () => void;
  /** The one album whose cover morphs between its card and the album page. Only set while
   * entering or leaving that album, so ordinary grid-to-grid navigation never animates covers. */
  morphAlbum: number | null;
  /** A focused editor (lyrics sync) owns the keyboard; global shortcuts stand down. */
  captureKeys: boolean;
  setCaptureKeys: (on: boolean) => void;
  toasts: Toast[];
  navigate: (r: Route) => void;
  goBack: () => void;
  goForward: () => void;
  setQuery: (q: string) => void;
  toggleQueue: () => void;
  setNowPlaying: (open: boolean) => void;
  openMenu: (x: number, y: number, items: MenuItem[]) => void;
  closeMenu: () => void;
  showInfo: (id: number | null) => void;
  /** Smart playlist rule editor: `id` null creates a new one. */
  smartEditor: { id: number | null } | null;
  editSmart: (id: number | null) => void;
  closeSmartEditor: () => void;
  toast: (message: string) => void;
}

let toastId = 0;

const morphFor = (from: Route, to: Route) =>
  to.name === "album" ? to.id : from.name === "album" ? from.id : null;

export const useUi = create<UiState>((set, get) => ({
  route: { name: "home" },
  back: [],
  forward: [],
  query: "",
  queueOpen: false,
  nowPlaying: false,
  menu: null,
  info: null,
  lyrics: localStorage.getItem("reson.lyrics") === "1",
  toggleLyrics: () => {
    const next = !get().lyrics;
    localStorage.setItem("reson.lyrics", next ? "1" : "0");
    set({ lyrics: next });
  },
  morphAlbum: null,
  captureKeys: false,
  setCaptureKeys: (on) => set({ captureKeys: on }),
  toasts: [],
  navigate: (r) => {
    const { route, back } = get();
    if (JSON.stringify(r) === JSON.stringify(route)) return;
    set({ route: r, back: [...back.slice(-49), route], forward: [], nowPlaying: false, morphAlbum: morphFor(route, r) });
  },
  goBack: () => {
    const { back, route, forward } = get();
    const prev = back.at(-1);
    if (prev) set({ route: prev, back: back.slice(0, -1), forward: [route, ...forward], morphAlbum: morphFor(route, prev) });
  },
  goForward: () => {
    const { back, route, forward } = get();
    const [next, ...rest] = forward;
    if (next) set({ route: next, back: [...back, route], forward: rest, morphAlbum: morphFor(route, next) });
  },
  setQuery: (q) => {
    const { route } = get();
    if (q && route.name !== "search") get().navigate({ name: "search" });
    if (!q && route.name === "search") get().goBack();
    set({ query: q });
  },
  toggleQueue: () => set((s) => ({ queueOpen: !s.queueOpen })),
  setNowPlaying: (open) => set({ nowPlaying: open }),
  openMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: null }),
  showInfo: (id) => set({ info: id }),
  smartEditor: null,
  editSmart: (id) => set({ smartEditor: { id }, menu: null }),
  closeSmartEditor: () => set({ smartEditor: null }),
  toast: (message) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
  },
}));
