import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useMotionValueEvent, useReducedMotion } from "motion/react";
import { ArrowDown, ArrowUp, MusicNotesSimple } from "@phosphor-icons/react";
import { api } from "../../lib/api";
import { clock } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { activeLine, type LyricLine } from "../../lib/lrc";
import { usePlayer } from "../../store/player";

/** Highlight a hair early: the eye wants to arrive at the line just before the voice does. */
const LEAD = 0.12;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
/** The visible band between the top and bottom fades of the lyrics mask. */
const VIEW_TOP = 0.14;
const VIEW_BOTTOM = 0.8;

/** Current lyric line index for the playing track, re-rendering only when it changes. */
export function useActiveLine(lines: LyricLine[], offsetMs: number) {
  const shift = offsetMs / 1000 + LEAD;
  const [index, setIndex] = useState(() => activeLine(lines, clock.get() + shift));
  useMotionValueEvent(clock, "change", (t) => {
    const i = activeLine(lines, t + shift);
    if (i !== index) setIndex(i);
  });
  useEffect(() => setIndex(activeLine(lines, clock.get() + shift)), [lines, shift]);
  return index;
}

/** The sung line, with each word filling left-to-right as it's sung. Writes styles directly. */
function KaraokeText({ line, shift }: { line: LyricLine; shift: number }) {
  const refs = useRef<(HTMLSpanElement | null)[]>([]);
  const paint = (t: number) => {
    const now = t + shift;
    line.words.forEach((w, i) => {
      const el = refs.current[i];
      if (!el) return;
      const p = w.end > w.start ? (now - w.start) / (w.end - w.start) : now >= w.start ? 1 : 0;
      el.style.setProperty("--p", `${Math.min(108, Math.max(-8, p * 116 - 8)).toFixed(1)}%`);
    });
  };
  useMotionValueEvent(clock, "change", paint);
  useEffect(() => paint(clock.get()));
  return (
    <>
      {line.words.map((w, i) => (
        <span
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="karaoke-word"
        >
          {w.text}
        </span>
      ))}
    </>
  );
}

/** Instrumental break: three dots that light up across the gap. */
function BreakDots({ line, active, shift }: { line: LyricLine; active: boolean; shift: number }) {
  const refs = useRef<(HTMLSpanElement | null)[]>([]);
  const paint = (t: number) => {
    const p = active && line.end > line.time ? (t + shift - line.time) / (line.end - line.time) : 0;
    refs.current.forEach((el, i) => {
      if (!el) return;
      const lit = Math.min(1, Math.max(0, p * 3 - i));
      el.style.opacity = String(0.25 + lit * 0.75);
      el.style.transform = `scale(${0.8 + lit * 0.35})`;
    });
  };
  useMotionValueEvent(clock, "change", paint);
  useEffect(() => paint(clock.get()));
  return (
    <span className="inline-flex gap-2.5 py-3" aria-label="Instrumental break">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="h-3 w-3 rounded-full bg-current transition-[opacity,transform] duration-200"
        />
      ))}
    </span>
  );
}

const Line = memo(function Line({
  line,
  distance,
  past,
  browsing,
  karaoke,
  shift,
  onSeek,
}: {
  line: LyricLine;
  /** Lines away from the active one; 0 = active. */
  distance: number;
  past: boolean;
  browsing: boolean;
  karaoke: boolean;
  shift: number;
  onSeek: (t: number) => void;
}) {
  const active = distance === 0;
  // Apple-style depth: the further from the sung line, the softer and smaller.
  const depth = browsing ? 0 : Math.min(distance, 5);
  const style = {
    filter: depth ? `blur(${(depth * 0.55).toFixed(2)}px)` : undefined,
    opacity: active ? 1 : browsing ? 0.6 : past ? Math.max(0.16, 0.38 - depth * 0.04) : Math.max(0.2, 0.62 - depth * 0.09),
    transform: `scale(${active ? 1 : 0.965})`,
  };
  return (
    <button
      type="button"
      data-active={active || undefined}
      onClick={() => onSeek(line.time)}
      style={style}
      className="block w-full origin-left py-2.5 text-left text-[26px] font-semibold leading-[1.28] tracking-tight text-ink transition-[filter,opacity,transform] duration-700 ease-out-expo hover:!opacity-90 hover:!blur-none lg:text-[32px]"
    >
      {!line.text ? (
        <BreakDots line={line} active={active} shift={shift} />
      ) : active && karaoke ? (
        <KaraokeText line={line} shift={shift} />
      ) : (
        line.text
      )}
    </button>
  );
});

export function SyncedLyrics({ lines, offsetMs, karaoke }: { lines: LyricLine[]; offsetMs: number; karaoke: boolean }) {
  const index = useActiveLine(lines, offsetMs);
  const box = useRef<HTMLDivElement>(null);
  // Scrolling by hand stops following the song (and drops the depth blur) until the user taps
  // "Sync lyrics", picks a line, or the song changes.
  const [browsing, setBrowsing] = useState(false);
  /** Where the sung line is relative to the visible band while browsing, for the pill's arrow. */
  const [away, setAway] = useState<"up" | "down" | null>(null);
  const reduce = useReducedMotion();
  const shift = offsetMs / 1000 + LEAD;

  const browse = () => setBrowsing(true);
  const resync = () => {
    setBrowsing(false);
    setAway(null);
  };
  useEffect(() => {
    resync();
  }, [lines]);

  const measure = () => {
    const el = box.current;
    const line = el?.querySelector<HTMLElement>("[data-active]");
    if (!el || !line) return setAway(null);
    const top = line.offsetTop - el.scrollTop;
    setAway(
      top + line.offsetHeight < el.clientHeight * VIEW_TOP ? "up" : top > el.clientHeight * VIEW_BOTTOM ? "down" : null,
    );
  };
  useEffect(() => {
    if (browsing) measure();
  }, [index, browsing]);

  useEffect(() => {
    const el = box.current;
    if (!el || browsing) return;
    const target = el.querySelector<HTMLElement>("[data-active]") ?? el.firstElementChild;
    if (!(target instanceof HTMLElement)) return;
    el.scrollTo({ top: target.offsetTop - el.clientHeight * 0.36, behavior: reduce ? "auto" : "smooth" });
  }, [index, reduce, browsing]);

  const seek = (t: number) => {
    resync();
    const target = Math.max(0, t - offsetMs / 1000);
    usePlayer.getState().seekLocal(target);
    api.seek(target);
  };

  const Arrow = away === "up" ? ArrowUp : away === "down" ? ArrowDown : MusicNotesSimple;

  return (
    <div className="relative h-full">
      <div
        ref={box}
        onWheel={browse}
        onTouchMove={browse}
        onKeyDown={(e: KeyboardEvent) => {
          if (SCROLL_KEYS.has(e.key)) browse();
        }}
        onScroll={() => {
          if (browsing) measure();
        }}
        className={cn("relative h-full overflow-y-auto pr-4 [scrollbar-width:none]")}
        style={{
          maskImage: "linear-gradient(transparent, black 14%, black 80%, transparent)",
          WebkitMaskImage: "linear-gradient(transparent, black 14%, black 80%, transparent)",
        }}
      >
        <div className="h-[34%]" aria-hidden />
        {lines.map((l, i) => (
          <Line
            key={i}
            line={l}
            distance={index < 0 ? i + 1 : Math.abs(i - index)}
            past={i < index}
            browsing={browsing}
            karaoke={karaoke}
            shift={shift}
            onSeek={seek}
          />
        ))}
        <div className="h-[50%]" aria-hidden />
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center pr-4">
        <AnimatePresence>
          {browsing && (
            <motion.button
              key="sync"
              type="button"
              onClick={resync}
              initial={{ opacity: 0, y: 14, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.94 }}
              transition={{ type: "spring", stiffness: 460, damping: 34 }}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              className="pointer-events-auto inline-flex h-10 items-center gap-2 rounded-full bg-white/[0.16] pl-3.5 pr-4 text-sm font-medium text-ink shadow-[0_10px_30px_-12px_rgb(0_0_0/0.6)] ring-1 ring-white/10 backdrop-blur-xl transition-colors hover:bg-white/[0.24]"
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={away ?? "here"}
                  initial={{ opacity: 0, y: away === "up" ? 6 : -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: away === "up" ? -6 : 6 }}
                  transition={{ duration: 0.18 }}
                  className="grid place-items-center"
                >
                  <Arrow size={16} weight="bold" />
                </motion.span>
              </AnimatePresence>
              Sync lyrics
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
