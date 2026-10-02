import { useEffect } from "react";
import { ArrowsOutSimple, PictureInPicture, Queue } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { api, type Track } from "../lib/api";
import { cn } from "../lib/cn";
import { useLyrics } from "../store/lyrics";
import { useCurrentTrack } from "../store/player";
import { usePrefs } from "../store/prefs";
import { useUi } from "../store/ui";
import { IconButton } from "./Buttons";
import { Cover } from "./Cover";
import { FormatBadge } from "./FormatBadge";
import { useActiveLine } from "./lyrics/SyncedLyrics";
import { Progress, Transport, Volume } from "./PlayerControls";

/** The line being sung, under the artist. Cross-fades as lines change. */
function BarLyric({ track }: { track: Track }) {
  const entry = useLyrics((s) => s.byTrack[track.id]);
  const load = useLyrics((s) => s.load);
  useEffect(() => {
    load(track.id);
  }, [track.id, load]);
  const lines = entry?.status === "ready" ? entry.lines : [];
  const offset = entry?.status === "ready" ? entry.lyrics.offsetMs : 0;
  const index = useActiveLine(lines, offset);
  const text = index >= 0 ? lines[index]?.text : "";
  if (!lines.length) return null;
  return (
    <div className="relative h-4 overflow-hidden">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.p
          key={index}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="truncate text-xs italic text-ink/70"
        >
          {text || "\u00a0"}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

export function PlayerBar() {
  const { track, album } = useCurrentTrack();
  const navigate = useUi((s) => s.navigate);
  const queueOpen = useUi((s) => s.queueOpen);
  const toggleQueue = useUi((s) => s.toggleQueue);
  const nowPlaying = useUi((s) => s.nowPlaying);
  const setNowPlaying = useUi((s) => s.setNowPlaying);
  const showInfo = useUi((s) => s.showInfo);
  const barLyrics = usePrefs((s) => s.ui.barLyrics);

  return (
    <footer className="grid h-[88px] grid-cols-[minmax(0,1fr)_minmax(0,600px)_minmax(0,1fr)] items-center gap-6 px-4">
      <div className="flex min-w-0 items-center gap-3">
        {track ? (
          <>
            <button
              type="button"
              aria-label="Open now playing"
              onClick={() => setNowPlaying(true)}
              className="group relative h-14 w-14 shrink-0"
            >
              {!nowPlaying && (
                <motion.div layoutId="np-cover" className="h-14 w-14" transition={{ type: "spring", stiffness: 260, damping: 30 }}>
                  <Cover album={album} className="h-14 w-14 shadow-lg" />
                </motion.div>
              )}
              <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
                <ArrowsOutSimple size={18} />
              </span>
            </button>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={track.id}
                initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className="min-w-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => album && navigate({ name: "album", id: album.id })}
                    className="truncate text-left text-sm font-medium text-ink hover:underline"
                  >
                    {track.title}
                  </button>
                  <button type="button" aria-label="Song info" onClick={() => showInfo(track.id)} className="shrink-0">
                    <FormatBadge track={track} />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => album && navigate({ name: "artist", artist: album.artist })}
                  className="block max-w-full truncate text-left text-xs text-ink-muted hover:text-ink hover:underline"
                >
                  {track.artist}
                </button>
                {barLyrics && <BarLyric track={track} />}
              </motion.div>
            </AnimatePresence>
          </>
        ) : (
          <p className="pl-1 text-sm text-ink-faint">Nothing playing</p>
        )}
      </div>

      <div className="flex flex-col items-center gap-1.5">
        <Transport />
        <Progress />
      </div>

      <div className="flex items-center justify-end gap-1">
        <IconButton label="Now playing" onClick={() => setNowPlaying(true)} disabled={!track}>
          <ArrowsOutSimple size={18} />
        </IconButton>
        <IconButton label="Mini player" onClick={() => api.miniPlayer(true)}>
          <PictureInPicture size={18} />
        </IconButton>
        <IconButton label="Queue" active={queueOpen} onClick={toggleQueue} className={cn(queueOpen && "bg-white/[0.06]")}>
          <Queue size={18} />
        </IconButton>
        <Volume />
      </div>
    </footer>
  );
}
