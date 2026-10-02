import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ScrollContext } from "./lib/scroll";
import { useBridge } from "./hooks/useBridge";
import { useShortcuts } from "./hooks/useShortcuts";
import { applyPalette, paletteOf } from "./lib/theme";
import { clickSuppressed } from "./store/drag";
import { useCurrentTrack } from "./store/player";
import { useLibrary } from "./store/library";
import { useUi, type Route } from "./store/ui";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { PlayerBar } from "./components/PlayerBar";
import { QueuePanel } from "./components/QueuePanel";
import { NowPlaying } from "./components/NowPlaying";
import { ContextMenu } from "./components/ContextMenu";
import { Toasts } from "./components/Toasts";
import { DropOverlay } from "./components/DropOverlay";
import { DragLayer } from "./components/DragLayer";
import { SongInfo } from "./components/SongInfo";
import { HomeView } from "./views/HomeView";
import { SettingsView } from "./views/SettingsView";
import { AlbumsView } from "./views/AlbumsView";
import { AlbumView } from "./views/AlbumView";
import { SongsView } from "./views/SongsView";
import { ArtistsView } from "./views/ArtistsView";
import { ArtistView } from "./views/ArtistView";
import { PlaylistView } from "./views/PlaylistView";
import { SearchView } from "./views/SearchView";
import { EmptyLibrary } from "./views/EmptyLibrary";
import { LibrarySkeleton } from "./views/LibrarySkeleton";

function View() {
  const route = useUi((s) => s.route);
  const loaded = useLibrary((s) => s.loaded);
  const empty = useLibrary((s) => s.tracks.length === 0);

  if (route.name === "settings") return <SettingsView />;
  if (!loaded) return <LibrarySkeleton />;
  if (route.name === "playlist") return <PlaylistView id={route.id} rename={route.rename} />;
  if (empty) return <EmptyLibrary />;
  switch (route.name) {
    case "home":
      return <HomeView />;
    case "albums":
      return <AlbumsView />;
    case "album":
      return <AlbumView id={route.id} />;
    case "songs":
      return <SongsView />;
    case "artists":
      return <ArtistsView />;
    case "artist":
      return <ArtistView name={route.artist} />;
    case "search":
      return <SearchView />;
  }
}

/** Pages fade up on navigation, except into or out of an album page, where the cover morph is
 * the transition (a fading parent would hide the flying cover). */
function PageTransition({ route, children }: { route: Route; children: ReactNode }) {
  const prev = useRef<Route>(route);
  const morph = route.name === "album" || prev.current.name === "album";
  useEffect(() => {
    prev.current = route;
  }, [route]);
  return (
    <motion.div
      key={JSON.stringify(route)}
      initial={morph ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

export default function App() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const route = useUi((s) => s.route);
  const queueOpen = useUi((s) => s.queueOpen);
  const nowPlaying = useUi((s) => s.nowPlaying);
  const info = useUi((s) => s.info);
  const { album } = useCurrentTrack();

  useBridge(useCallback((over: boolean) => setDragging(over), []));
  useShortcuts();

  useEffect(() => {
    applyPalette(paletteOf(album));
  }, [album]);
  // Before paint, so shared-element animations measure the new page at its final scroll position.
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [route]);
  // A click that ends a drag shouldn't also activate whatever it was released on.
  useEffect(() => {
    const swallow = (e: MouseEvent) => {
      if (clickSuppressed()) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    window.addEventListener("click", swallow, true);
    return () => window.removeEventListener("click", swallow, true);
  }, []);

  return (
    // The explicit minmax(0,1fr) column matters: an implicit auto column would grow to fit the
    // player bar's longest unwrapped text (e.g. a long lyric line) and push the layout off screen.
    <div className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] bg-bg text-ink">
      <div className="flex min-h-0 gap-2 p-2 pb-0">
        <Sidebar />
        <main className="panel relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-80"
            style={{ background: "linear-gradient(180deg, color-mix(in oklab, var(--surface) 70%, transparent), transparent)" }}
          />
          <ScrollContext.Provider value={scrollRef}>
            <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
              <TopBar />
              <PageTransition route={route}>
                <View />
              </PageTransition>
            </div>
          </ScrollContext.Provider>
        </main>
        <AnimatePresence initial={false}>{queueOpen && <QueuePanel key="queue" />}</AnimatePresence>
      </div>
      <PlayerBar />
      <AnimatePresence>{nowPlaying && <NowPlaying key="np" />}</AnimatePresence>
      <AnimatePresence>{info != null && <SongInfo key="info" id={info} />}</AnimatePresence>
      <ContextMenu />
      <Toasts />
      <DragLayer />
      <AnimatePresence>{dragging && <DropOverlay key="drop" />}</AnimatePresence>
    </div>
  );
}
