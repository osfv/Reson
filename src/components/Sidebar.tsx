import type { MouseEvent, ReactNode } from "react";
import { GearSix, House, MicrophoneStage, MusicNotesSimple, Plus, Sparkle, VinylRecord } from "@phosphor-icons/react";
import { motion, AnimatePresence } from "motion/react";
import { addSuggestedSmartPlaylists, createPlaylist, importFiles, importFolders, smartPlaylistMenu } from "../lib/actions";
import { cn } from "../lib/cn";
import { plural } from "../lib/format";
import { clickSuppressed, useDrag } from "../store/drag";
import { albumCovers, useLibrary } from "../store/library";
import { useUi, type Route } from "../store/ui";
import { Mosaic } from "./Cover";
import { IconButton } from "./Buttons";

function NavItem({ route, icon, children }: { route: Route; icon: ReactNode; children: ReactNode }) {
  const current = useUi((s) => s.route);
  const navigate = useUi((s) => s.navigate);
  const active =
    current.name === route.name ||
    (route.name === "albums" && current.name === "album") ||
    (route.name === "artists" && current.name === "artist");
  return (
    <button
      type="button"
      onClick={() => navigate(route)}
      className={cn(
        "relative flex h-10 w-full items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
        active ? "text-ink" : "text-ink-muted hover:text-ink",
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-md bg-white/[0.07]"
          transition={{ type: "spring", stiffness: 500, damping: 38 }}
        />
      )}
      <span className={cn("relative", active && "text-accent")}>{icon}</span>
      <span className="relative">{children}</span>
    </button>
  );
}

function ScanStatus() {
  const scan = useLibrary((s) => s.scan);
  return (
    <AnimatePresence>
      {scan?.active && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className="mx-1 mb-2 rounded-md bg-white/[0.05] px-3 py-2.5"
          role="status"
        >
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-medium text-ink">Importing</span>
            <span className="font-mono text-ink-muted tabular-nums">
              {scan.done.toLocaleString()} / {scan.total.toLocaleString()}
            </span>
          </div>
          <div className="mt-2 h-0.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full origin-left bg-accent transition-transform duration-200"
              style={{ transform: `scaleX(${scan.total ? scan.done / scan.total : 0})` }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SmartPlaylists() {
  const smart = useLibrary((s) => s.smartPlaylists);
  const trackById = useLibrary((s) => s.trackById);
  const albumById = useLibrary((s) => s.albumById);
  const route = useUi((s) => s.route);
  const navigate = useUi((s) => s.navigate);
  const openMenu = useUi((s) => s.openMenu);
  const editSmart = useUi((s) => s.editSmart);

  return (
    <>
      <div className="mt-4 flex items-center justify-between pl-3">
        <h2 className="text-sm font-medium text-ink-muted">Smart playlists</h2>
        <IconButton label="New smart playlist" onClick={() => editSmart(null)}>
          <Plus size={18} />
        </IconButton>
      </div>
      {smart.length === 0 ? (
        <div className="px-3 py-2 text-[13px] leading-relaxed text-ink-faint">
          <p>Playlists that fill themselves from rules, like your most played songs.</p>
          <button
            type="button"
            onClick={addSuggestedSmartPlaylists}
            className="mt-1.5 font-medium text-ink-muted underline-offset-2 transition-colors hover:text-ink hover:underline"
          >
            Add suggestions
          </button>
        </div>
      ) : (
        smart.map((p) => {
          const active = route.name === "smart" && route.id === p.id;
          const tracks = p.trackIds.map((id) => trackById.get(id)).filter((t) => t != null);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => navigate({ name: "smart", id: p.id })}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, smartPlaylistMenu(p.id));
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-md p-1.5 text-left transition-colors",
                active ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
              )}
            >
              <span className="relative shrink-0">
                <Mosaic albums={albumCovers(tracks, albumById)} className="h-10 w-10 rounded-md" />
                <Sparkle size={12} weight="fill" className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[var(--surface)] p-[1px] text-accent" />
              </span>
              <span className="min-w-0">
                <span className={cn("block truncate text-sm", active ? "text-accent" : "text-ink")}>{p.name}</span>
                <span className="block truncate text-xs text-ink-muted">{plural(tracks.length, "song")}</span>
              </span>
            </button>
          );
        })
      )}
    </>
  );
}

export function Sidebar() {
  const playlists = useLibrary((s) => s.playlists);
  const trackById = useLibrary((s) => s.trackById);
  const albumById = useLibrary((s) => s.albumById);
  const route = useUi((s) => s.route);
  const navigate = useUi((s) => s.navigate);
  const openMenu = useUi((s) => s.openMenu);
  const dragging = useDrag((s) => s.payload != null);
  const over = useDrag((s) => s.over);

  const addMenu = (e: MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.left, r.top - 8, [
      { label: "Add folder", onSelect: importFolders },
      { label: "Add files", onSelect: importFiles },
    ]);
  };

  return (
    <aside className="panel flex w-60 shrink-0 flex-col rounded-2xl">
      <div className="flex h-14 items-center px-5">
        <span className="text-[17px] font-semibold tracking-tight">Reson</span>
      </div>
      <nav className="flex flex-col gap-0.5 px-2" aria-label="Library">
        <NavItem route={{ name: "home" }} icon={<House />}>
          Home
        </NavItem>
        <NavItem route={{ name: "albums" }} icon={<VinylRecord />}>
          Albums
        </NavItem>
        <NavItem route={{ name: "songs" }} icon={<MusicNotesSimple />}>
          Songs
        </NavItem>
        <NavItem route={{ name: "artists" }} icon={<MicrophoneStage />}>
          Artists
        </NavItem>
      </nav>

      <div className="mt-6 flex items-center justify-between pl-5 pr-2">
        <h2 className="text-sm font-medium text-ink-muted">Playlists</h2>
        <IconButton label="New playlist" onClick={() => createPlaylist()}>
          <Plus size={18} />
        </IconButton>
      </div>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {dragging && (
          <motion.div
            data-drop="new-playlist"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className={cn(
              "mb-1 flex items-center gap-3 rounded-md border border-dashed p-1.5 text-sm transition-colors",
              over === "new-playlist" ? "border-accent bg-white/[0.06] text-ink" : "border-white/15 text-ink-muted",
            )}
          >
            <span className="grid h-10 w-10 place-items-center rounded-md bg-white/[0.06]">
              <Plus size={18} />
            </span>
            New playlist
          </motion.div>
        )}
        {playlists.length === 0 ? (
          !dragging && (
            <p className="px-3 py-2 text-[13px] leading-relaxed text-ink-faint">
              Create a playlist, or drag songs here to start one.
            </p>
          )
        ) : (
          playlists.map((p) => {
            const active = route.name === "playlist" && route.id === p.id;
            const tracks = p.trackIds.map((id) => trackById.get(id)).filter((t) => t != null);
            const target = over === `playlist:${p.id}`;
            return (
              <motion.button
                key={p.id}
                type="button"
                data-drop={`playlist:${p.id}`}
                animate={{ scale: target ? 1.03 : 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                onClick={() => !clickSuppressed() && navigate({ name: "playlist", id: p.id })}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md p-1.5 text-left transition-colors",
                  target ? "bg-white/[0.1] ring-1 ring-accent" : active ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
                )}
              >
                <Mosaic albums={albumCovers(tracks, albumById)} className="h-10 w-10 rounded-md" />
                <span className="min-w-0">
                  <span className={cn("block truncate text-sm", active ? "text-accent" : "text-ink")}>{p.name}</span>
                  <span className="block truncate text-xs text-ink-muted">{plural(tracks.length, "song")}</span>
                </span>
              </motion.button>
            );
          })
        )}
        <SmartPlaylists />
      </div>

      <ScanStatus />
      <div className="flex items-center gap-1 border-t border-line p-2">
        <button
          type="button"
          onClick={addMenu}
          className="flex h-10 flex-1 items-center gap-3 rounded-md px-3 text-sm font-medium text-ink-muted transition-colors hover:bg-white/[0.04] hover:text-ink"
        >
          <Plus />
          Add music
        </button>
        <IconButton
          label="Settings"
          active={route.name === "settings"}
          onClick={() => navigate({ name: "settings" })}
          className="h-10 w-10"
        >
          <GearSix size={19} />
        </IconButton>
      </div>
    </aside>
  );
}
