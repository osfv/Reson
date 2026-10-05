import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DownloadSimple, Play, X } from "@phosphor-icons/react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { Album, YearStats } from "../lib/api";
import { playTracks } from "../lib/actions";
import { plural } from "../lib/format";
import { paletteOf } from "../lib/theme";
import { useUi } from "../store/ui";
import { CountUp, formatDay, monthName, MonthChart, useYearData } from "./year/shared";
import { PillButton } from "./Buttons";
import { Cover } from "./Cover";
import { MeshBackdrop } from "./np/MeshBackdrop";

const SLIDE_MS = 6500;
const ease = [0.16, 1, 0.3, 1] as const;

interface Slide {
  key: string;
  album?: Album;
  body: ReactNode;
}

/** Fades and lifts children in one after another. */
function Rise({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24, filter: "blur(8px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ delay, duration: 0.8, ease }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

const Kicker = ({ children }: { children: ReactNode }) => (
  <p className="font-mono text-sm uppercase tracking-[0.22em] text-ink-muted">{children}</p>
);

export function YearStory({ stats, onClose, onSave }: { stats: YearStats; onClose: () => void; onSave: () => void }) {
  const data = useYearData(stats)!;
  const reduce = useReducedMotion();
  const setCaptureKeys = useUi((s) => s.setCaptureKeys);
  const navigate = useUi((s) => s.navigate);
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const progress = useMotionValue(0);
  const downAt = useRef(0);

  const slides = useMemo<Slide[]>(() => {
    const out: Slide[] = [];
    const top = data.topTracks[0];
    const topAlbum = data.topAlbums[0]?.album;
    const hours = stats.minutes / 60;
    out.push({
      key: "intro",
      album: topAlbum,
      body: (
        <div className="text-center">
          <Rise>
            <Kicker>Your year in music</Kicker>
          </Rise>
          <Rise delay={0.15}>
            <h1 className="mt-4 text-[clamp(7rem,22vw,16rem)] font-semibold leading-none tracking-[-0.05em]">{stats.year}</h1>
          </Rise>
          <Rise delay={0.5}>
            <p className="mt-6 text-xl text-ink-muted">Let's look back at what you played.</p>
          </Rise>
        </div>
      ),
    });
    out.push({
      key: "minutes",
      album: topAlbum,
      body: (
        <div>
          <Rise>
            <Kicker>Time well spent</Kicker>
          </Rise>
          <Rise delay={0.2}>
            <p className="mt-6 text-3xl text-ink-muted">You listened for</p>
            <p className="mt-2 text-[clamp(4.5rem,12vw,9rem)] font-semibold leading-none tracking-[-0.04em] tabular-nums">
              <CountUp value={Math.round(stats.minutes)} />
            </p>
            <p className="mt-2 text-3xl font-medium">minutes</p>
          </Rise>
          <Rise delay={1.2}>
            <p className="mt-8 max-w-[40ch] text-lg text-ink-muted">
              {hours >= 48
                ? `That's ${(hours / 24).toFixed(1)} full days of music, across ${plural(stats.songs, "song")}.`
                : `That's ${hours.toFixed(1)} hours of music, across ${plural(stats.songs, "song")}.`}
            </p>
          </Rise>
        </div>
      ),
    });
    if (top) {
      const album = data.albumById.get(top.track.albumId);
      out.push({
        key: "song",
        album,
        body: (
          <div className="flex flex-col items-center text-center">
            <Rise>
              <Kicker>Your song of the year</Kicker>
            </Rise>
            <motion.div
              initial={{ opacity: 0, scale: 0.8, rotate: -6 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              transition={{ delay: 0.2, type: "spring", stiffness: 140, damping: 16 }}
              className="mt-8"
            >
              <Cover album={album} className="h-[min(42vh,380px)] w-[min(42vh,380px)] rounded-xl shadow-[0_40px_100px_-30px_rgb(0_0_0/0.8)]" />
            </motion.div>
            <Rise delay={0.7}>
              <h2 className="mt-8 line-clamp-2 max-w-[18ch] text-5xl font-semibold leading-[1.05] tracking-tight">{top.track.title}</h2>
              <p className="mt-3 text-2xl text-ink-muted">{top.track.artist}</p>
              <p className="mt-4 font-mono text-sm text-ink-faint">You played it {plural(top.plays, "time")}.</p>
            </Rise>
          </div>
        ),
      });
    }
    if (data.topTracks.length > 1) {
      out.push({
        key: "top5",
        album: data.albumById.get(data.topTracks[1].track.albumId),
        body: (
          <div className="w-full max-w-xl">
            <Rise>
              <Kicker>On repeat</Kicker>
              <h2 className="mt-3 text-5xl font-semibold tracking-tight">Your top songs</h2>
            </Rise>
            <ol className="mt-8 flex flex-col gap-3">
              {data.topTracks.slice(0, 5).map(({ track, plays }, i) => (
                <motion.li
                  key={track.id}
                  initial={{ opacity: 0, x: 40 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.35 + i * 0.12, duration: 0.6, ease }}
                  className="flex items-center gap-4"
                >
                  <span className="w-8 text-right text-3xl font-semibold text-ink-faint tabular-nums">{i + 1}</span>
                  <Cover album={data.albumById.get(track.albumId)} className="h-16 w-16 rounded-md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xl font-medium">{track.title}</span>
                    <span className="block truncate text-ink-muted">{track.artist}</span>
                  </span>
                  <span className="font-mono text-sm text-ink-faint">{plays}</span>
                </motion.li>
              ))}
            </ol>
          </div>
        ),
      });
    }
    const artist = stats.topArtists[0];
    if (artist) {
      const theirs = data.topAlbums.filter((a) => a.album.artist === artist[0]).map((a) => a.album);
      out.push({
        key: "artist",
        album: theirs[0] ?? topAlbum,
        body: (
          <div className="text-center">
            <Rise>
              <Kicker>Your top artist</Kicker>
            </Rise>
            <div className="mt-8 flex justify-center">
              {theirs.slice(0, 3).map((a, i, all) => (
                <motion.div
                  key={a.id}
                  initial={{ opacity: 0, y: 40, rotate: 0 }}
                  animate={{ opacity: 1, y: 0, rotate: (i - (all.length - 1) / 2) * 9 }}
                  transition={{ delay: 0.2 + i * 0.1, type: "spring", stiffness: 150, damping: 17 }}
                  className="-mx-6"
                  style={{ zIndex: i === 1 ? 2 : 1 }}
                >
                  <Cover album={a} className="h-44 w-44 rounded-xl shadow-[0_30px_70px_-25px_rgb(0_0_0/0.85)]" />
                </motion.div>
              ))}
            </div>
            <Rise delay={0.6}>
              <h2 className="mt-10 text-[clamp(3rem,8vw,6rem)] font-semibold leading-none tracking-[-0.03em]">{artist[0]}</h2>
              <p className="mt-4 text-xl text-ink-muted">
                {Math.round(artist[2]).toLocaleString()} minutes, {plural(artist[1], "play")}
              </p>
            </Rise>
          </div>
        ),
      });
    }
    if (data.topAlbums.length > 1) {
      out.push({
        key: "albums",
        album: data.topAlbums[1]?.album,
        body: (
          <div className="w-full max-w-3xl text-center">
            <Rise>
              <Kicker>Front to back</Kicker>
              <h2 className="mt-3 text-5xl font-semibold tracking-tight">Your top albums</h2>
            </Rise>
            <div className="mt-10 grid grid-cols-2 gap-5 sm:grid-cols-4">
              {data.topAlbums.slice(0, 4).map(({ album }, i) => (
                <motion.div
                  key={album.id}
                  initial={{ opacity: 0, scale: 0.85, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ delay: 0.3 + i * 0.1, type: "spring", stiffness: 180, damping: 18 }}
                >
                  <Cover album={album} className="aspect-square w-full rounded-xl shadow-[0_24px_60px_-24px_rgb(0_0_0/0.8)]" />
                  <p className="mt-3 truncate font-medium">{album.title}</p>
                  <p className="truncate text-sm text-ink-muted">{album.artist}</p>
                </motion.div>
              ))}
            </div>
          </div>
        ),
      });
    }
    if (stats.months.some((m) => m > 0)) {
      out.push({
        key: "months",
        album: topAlbum,
        body: (
          <div className="w-full max-w-3xl">
            <Rise>
              <Kicker>Your rhythm</Kicker>
              <h2 className="mt-3 text-5xl font-semibold tracking-tight">{monthName(data.topMonth)} was your biggest month</h2>
              <p className="mt-3 text-lg text-ink-muted">{Math.round(stats.months[data.topMonth]).toLocaleString()} minutes that month.</p>
            </Rise>
            <div className="mt-10">
              <MonthChart months={stats.months} highlight={data.topMonth} tall />
            </div>
          </div>
        ),
      });
    }
    out.push({
      key: "habits",
      album: data.topAlbums[2]?.album ?? topAlbum,
      body: (
        <div className="grid w-full max-w-3xl gap-10 sm:grid-cols-2">
          <Rise>
            <Kicker>Longest streak</Kicker>
            <p className="mt-4 text-8xl font-semibold leading-none tracking-tight tabular-nums">
              <CountUp value={stats.longestStreak} />
            </p>
            <p className="mt-3 text-xl text-ink-muted">{stats.longestStreak === 1 ? "day" : "days in a row with music"}</p>
          </Rise>
          {stats.topDay && (
            <Rise delay={0.35}>
              <Kicker>Biggest day</Kicker>
              <p className="mt-4 text-5xl font-semibold tracking-tight">{formatDay(stats.topDay[0])}</p>
              <p className="mt-3 text-xl text-ink-muted">{Math.round(stats.topDay[1]).toLocaleString()} minutes in one day</p>
            </Rise>
          )}
          {data.first && stats.firstTrack && (
            <Rise delay={0.7}>
              <Kicker>Where it started</Kicker>
              <p className="mt-4 line-clamp-2 text-3xl font-semibold tracking-tight">{data.first.title}</p>
              <p className="mt-2 text-lg text-ink-muted">
                {data.first.artist}, on {formatDay(stats.firstTrack[1])}
              </p>
            </Rise>
          )}
          {stats.topGenres[0] && (
            <Rise delay={1.05}>
              <Kicker>Top genre</Kicker>
              <p className="mt-4 text-3xl font-semibold tracking-tight">{stats.topGenres[0][0]}</p>
            </Rise>
          )}
        </div>
      ),
    });
    out.push({
      key: "outro",
      album: topAlbum,
      body: (
        <div className="text-center">
          <Rise>
            <h2 className="text-[clamp(3rem,8vw,6.5rem)] font-semibold leading-none tracking-[-0.03em]">That was your {stats.year}.</h2>
          </Rise>
          <Rise delay={0.4}>
            <p className="mt-6 text-xl text-ink-muted">Share it, or play the songs that made it.</p>
          </Rise>
          <Rise delay={0.7} className="mt-10 flex flex-wrap justify-center gap-3">
            <PillButton primary onClick={onSave}>
              <DownloadSimple size={16} weight="bold" />
              Save as image
            </PillButton>
            <PillButton
              onClick={() => {
                playTracks(data.topTracks.map((t) => t.track.id));
                onClose();
              }}
              className="bg-black/30 hover:bg-white/10"
            >
              <Play size={16} weight="fill" />
              Play your top songs
            </PillButton>
          </Rise>
        </div>
      ),
    });
    return out;
  }, [data, stats, onSave, onClose]);

  const last = slides.length - 1;
  const go = (to: number) => setIndex(Math.max(0, Math.min(last, to)));

  // Auto-advance; holding the pointer down pauses (like stories elsewhere).
  useEffect(() => {
    progress.set(0);
    if (held || index === last) return;
    const controls = animate(progress, 1, { duration: SLIDE_MS / 1000, ease: "linear", onComplete: () => go(index + 1) });
    return () => controls.stop();
  }, [index, held, last]);

  useEffect(() => {
    setCaptureKeys(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === " ") go(index + 1);
      else if (e.key === "ArrowLeft") go(index - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      setCaptureKeys(false);
    };
  }, [index, onClose, setCaptureKeys]);

  const slide = slides[index];
  const palette = paletteOf(slide.album);

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={`Your ${stats.year} in music`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4, ease }}
      className="fixed inset-0 z-50 overflow-hidden bg-bg text-ink"
      style={{ "--accent": palette.accent, "--on-accent": palette.onAccent } as CSSProperties}
      onPointerDown={() => {
        downAt.current = performance.now();
        setHeld(true);
      }}
      onPointerUp={(e) => {
        setHeld(false);
        // A long press only pauses; a tap moves.
        if (performance.now() - downAt.current > 350 || (e.target as HTMLElement).closest("button")) return;
        go(e.clientX < window.innerWidth * 0.3 ? index - 1 : index + 1);
      }}
    >
      <AnimatePresence initial={false}>
        <motion.div
          key={slide.album?.id ?? "none"}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.2 }}
          className="absolute inset-0"
        >
          <MeshBackdrop palette={palette} playing={!reduce} reactive={false} />
        </motion.div>
      </AnimatePresence>

      <div className="absolute inset-x-0 top-0 z-10 flex gap-1.5 px-6 pt-5">
        {slides.map((s, i) => (
          <div key={s.key} className="h-1 flex-1 overflow-hidden rounded-full bg-white/20">
            {i < index ? (
              <div className="h-full w-full bg-ink" />
            ) : i === index ? (
              <motion.div className="h-full w-full origin-left bg-ink" style={{ scaleX: index === last ? 1 : progress }} />
            ) : null}
          </div>
        ))}
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-5 top-9 z-10 grid h-10 w-10 place-items-center rounded-full bg-black/25 text-ink transition-colors hover:bg-white/10"
      >
        <X size={18} />
      </button>
      <button
        type="button"
        onClick={() => {
          onClose();
          navigate({ name: "year", year: stats.year });
        }}
        className="sr-only"
      >
        Skip to the summary
      </button>

      <div className="relative flex h-full items-center justify-center px-8 py-20">
        <AnimatePresence mode="wait">
          <motion.div
            key={slide.key}
            exit={{ opacity: 0, y: -16, filter: "blur(6px)", transition: { duration: 0.3 } }}
            className="flex w-full justify-center"
          >
            {slide.body}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
