import { useEffect } from "react";
import { ArrowsOutSimple, SkipBack, SkipForward } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { IconButton, PlayButton } from "../components/Buttons";
import { Cover } from "../components/Cover";
import { Progress } from "../components/PlayerControls";
import { useBridge } from "../hooks/useBridge";
import { api } from "../lib/api";
import { applyPalette, paletteOf } from "../lib/theme";
import { useCurrentTrack, usePlayer } from "../store/player";

/** Compact always-on-top player, rendered in its own frameless window. */
export function MiniPlayer() {
  useBridge();
  const { track, album } = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const p = paletteOf(album);

  useEffect(() => {
    applyPalette(p);
  }, [p]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        api.toggle();
      } else if (e.key === "Escape") api.miniPlayer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [a, b] = p.swatches?.length ? p.swatches : [p.surface, p.bg];
  return (
    <div
      data-tauri-drag-region
      className="relative flex h-dvh select-none items-center gap-3 overflow-hidden p-2.5 pr-2 text-ink"
      style={{ background: `linear-gradient(120deg, ${a}, ${b ?? p.bg})`, transition: "background 1s ease" }}
    >
      <div data-tauri-drag-region className="absolute inset-0 bg-black/25" />
      <div className="relative h-[84px] w-[84px] shrink-0">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={album?.id ?? "none"}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: playing ? 1 : 0.92 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            className="h-full w-full"
            data-tauri-drag-region
          >
            <Cover album={album} className="h-full w-full shadow-lg" />
          </motion.div>
        </AnimatePresence>
      </div>
      <div data-tauri-drag-region className="relative flex min-w-0 flex-1 flex-col justify-center gap-1.5">
        <div data-tauri-drag-region className="min-w-0">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={track?.id ?? "none"}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              data-tauri-drag-region
            >
              <p data-tauri-drag-region className="truncate text-sm font-semibold">
                {track?.title ?? "Nothing playing"}
              </p>
              <p data-tauri-drag-region className="truncate text-xs text-ink-muted">
                {track?.artist ?? "Reson"}
              </p>
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Previous" onClick={() => api.prev()} className="h-8 w-8">
            <SkipBack size={16} weight="fill" />
          </IconButton>
          <PlayButton playing={playing} onClick={() => api.toggle()} size={32} />
          <IconButton label="Next" onClick={() => api.next()} className="h-8 w-8">
            <SkipForward size={16} weight="fill" />
          </IconButton>
          <div className="ml-1 min-w-0 flex-1">
            <Progress compact />
          </div>
        </div>
      </div>
      <IconButton label="Back to full player" onClick={() => api.miniPlayer(false)} className="relative h-8 w-8 self-start">
        <ArrowsOutSimple size={16} />
      </IconButton>
    </div>
  );
}
