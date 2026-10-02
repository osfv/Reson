import { useEffect } from "react";
import { CaretDown, Quotes } from "@phosphor-icons/react";
import { cn } from "../lib/cn";
import { LyricsPanel } from "./LyricsPanel";
import { AnimatePresence, motion, useReducedMotion, useTransform } from "motion/react";
import { api } from "../lib/api";
import { paletteOf } from "../lib/theme";
import { usePrefs } from "../store/prefs";
import { bass, kick, resetSpectrum } from "../store/spectrum";
import { MeshBackdrop } from "./np/MeshBackdrop";
import { SpectrumBars } from "./np/SpectrumBars";
import { useLibrary } from "../store/library";
import { useCurrentTrack, usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { IconButton } from "./Buttons";
import { Cover } from "./Cover";
import { FormatBadge } from "./FormatBadge";
import { mislabeled, qualityLabel } from "../lib/format";
import { Progress, Transport, Volume } from "./PlayerControls";

function UpNext() {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const trackById = useLibrary((s) => s.trackById);
  const albumById = useLibrary((s) => s.albumById);
  const next = index != null ? queue.slice(index + 1, index + 4) : [];
  if (!next.length) return null;
  return (
    <div className="mt-10">
      <h3 className="text-[13px] font-medium text-ink-muted">Up next</h3>
      <div className="mt-2 flex flex-col">
        {next.map((e) => {
          const t = trackById.get(e.id);
          if (!t) return null;
          return (
            <button
              key={e.uid}
              type="button"
              onClick={() => api.jump(e.uid)}
              className="-mx-2 flex items-center gap-3 rounded-md p-2 text-left transition-colors hover:bg-white/[0.06]"
            >
              <Cover album={albumById.get(t.albumId)} className="h-10 w-10 rounded-md" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{t.title}</span>
                <span className="block truncate text-xs text-ink-muted">{t.artist}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function NowPlaying() {
  const { track, album } = useCurrentTrack();
  const setNowPlaying = useUi((s) => s.setNowPlaying);
  const navigate = useUi((s) => s.navigate);
  const showInfo = useUi((s) => s.showInfo);
  const lyricsOpen = useUi((s) => s.lyrics);
  const toggleLyrics = useUi((s) => s.toggleLyrics);
  const playing = usePlayer((s) => s.playing);
  const bars = usePrefs((s) => s.ui.visualizer);
  const beatPulse = usePrefs((s) => s.ui.beatPulse);
  const reduce = useReducedMotion();
  const palette = paletteOf(album);
  const pulse = useTransform(() => (beatPulse && !reduce ? 1 + kick.get() * 0.025 + bass.get() * 0.012 : 1));
  // Audio analysis only runs while Now Playing is open and something actually uses it.
  const analyze = bars || beatPulse;
  useEffect(() => {
    if (!analyze) return;
    api.visualizer(true);
    return () => {
      api.visualizer(false);
      resetSpectrum();
    };
  }, [analyze]);

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="fixed inset-0 z-40 overflow-hidden bg-bg"
    >
      <MeshBackdrop palette={palette} playing={playing} reactive={beatPulse} />
      {bars && <SpectrumBars />}

      <div className="relative flex h-full flex-col">
        <div className="flex h-16 shrink-0 items-center justify-between px-6">
          <IconButton label="Close now playing" onClick={() => setNowPlaying(false)} className="bg-black/20">
            <CaretDown size={20} />
          </IconButton>
          <button
            type="button"
            onClick={toggleLyrics}
            aria-pressed={lyricsOpen}
            title="Lyrics (L)"
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-medium transition-[background-color,color,scale] active:scale-[0.97]",
              lyricsOpen ? "bg-ink text-[#141416]" : "bg-black/20 text-ink hover:bg-white/10",
            )}
          >
            <Quotes size={16} weight={lyricsOpen ? "fill" : "regular"} />
            Lyrics
          </button>
        </div>

        <div
          className={cn(
            "mx-auto grid min-h-0 w-full max-w-[1400px] flex-1 grid-cols-1 gap-10 px-6 pb-12 md:px-16",
            lyricsOpen
              ? "md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] md:gap-20"
              : "items-center md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] md:gap-16",
          )}
        >
          <div className={cn("min-w-0", lyricsOpen && "flex flex-col justify-center")}>
            <motion.div
              layout
              layoutId="np-cover"
              transition={{ type: "spring", stiffness: 260, damping: 30 }}
              className={cn(
                "aspect-square w-full",
                lyricsOpen ? "max-w-[min(40vh,420px)]" : "mx-auto max-w-[min(62vh,580px)]",
              )}
            >
              {/* The cover "settles back" when paused, so state is readable from across the room. */}
              <motion.div
                animate={{ scale: playing ? 1 : 0.9 }}
                transition={{ type: "spring", stiffness: 180, damping: 20 }}
                className="h-full w-full"
              >
                {/* Beat pulse: a small kick on each detected beat, plus a gentle swell with the bass. */}
                <motion.div className="h-full w-full" style={{ scale: pulse }}>
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={album?.id ?? "none"}
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 1.02 }}
                      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                      className="h-full w-full"
                    >
                      <Cover
                        album={album}
                        className={cn(
                          "h-full w-full rounded-xl transition-shadow duration-500",
                          playing
                            ? "shadow-[0_40px_100px_-30px_color-mix(in_oklab,var(--bg)_40%,black)]"
                            : "shadow-[0_20px_50px_-30px_color-mix(in_oklab,var(--bg)_40%,black)]",
                        )}
                      />
                    </motion.div>
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            </motion.div>
            {lyricsOpen && <div className="mt-8 max-w-[420px]">{details(true)}</div>}
          </div>

          {lyricsOpen && track ? (
            <motion.div
              key={`lyrics-${track.id}`}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="min-h-0 min-w-0"
            >
              <LyricsPanel track={track} />
            </motion.div>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
              className="min-w-0 max-w-xl"
            >
              {details(false)}
              <UpNext />
            </motion.div>
          )}
        </div>
      </div>
    </motion.div>
  );

  function details(compact: boolean) {
    return (
      <>
            {track ? (
              <motion.div
                key={track.id}
                initial={{ opacity: 0, y: 12, filter: "blur(6px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              >
                <h1
                  className={cn(
                    "line-clamp-2 pb-1 font-semibold leading-[1.08] tracking-tight",
                    compact ? "text-3xl" : "text-4xl lg:text-5xl",
                  )}
                >
                  {track.title}
                </h1>
                <button
                  type="button"
                  onClick={() => album && navigate({ name: "artist", artist: album.artist })}
                  className="mt-3 block max-w-full truncate text-left text-xl text-ink-muted hover:text-ink"
                >
                  {track.artist}
                </button>
                {album && (
                  <button
                    type="button"
                    onClick={() => navigate({ name: "album", id: album.id })}
                    className="mt-1 block max-w-full truncate text-left text-sm text-ink-faint hover:text-ink-muted"
                  >
                    {album.title}
                    {album.year ? `, ${album.year}` : ""}
                  </button>
                )}
                {track.format && (
                  <button
                    type="button"
                    onClick={() => showInfo(track.id)}
                    title="Song info"
                    className="mt-5 flex items-center gap-2.5 rounded-full text-left"
                  >
                    <FormatBadge track={track} />
                    <span className="font-mono text-xs text-ink-muted">{qualityLabel(track)}</span>
                    {mislabeled(track) && (
                      <span className="text-xs text-ink-muted">(file is named .{mislabeled(track)})</span>
                    )}
                  </button>
                )}
              </motion.div>
            ) : (
              <h1 className="text-4xl font-semibold tracking-tight">Nothing playing</h1>
            )}

            <div className={compact ? "mt-7" : "mt-10"}>
              <Progress thick />
            </div>
            <div className={cn("flex items-center justify-between", compact ? "mt-4" : "mt-6")}>
              <Transport size="lg" />
              {!compact && <Volume />}
            </div>
      </>
    );
  }
}
