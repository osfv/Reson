import { useEffect, useState, type ReactNode } from "react";
import { ArrowClockwise, MagnifyingGlass, Minus, Plus, Timer } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import type { Lyrics, Track } from "../lib/api";
import { useLyrics } from "../store/lyrics";
import { usePrefs } from "../store/prefs";
import { LyricsSearch } from "./lyrics/LyricsSearch";
import { LyricsSync } from "./lyrics/LyricsSync";
import { SyncedLyrics } from "./lyrics/SyncedLyrics";

const SOURCE_LABEL: Record<Lyrics["source"], string> = {
  lrclib: "Lyrics from LRCLIB",
  file: "Lyrics from the .lrc file next to this song",
  embedded: "Lyrics embedded in this file",
  user: "Lyrics you synced",
  none: "",
};

const OFFSET_STEP = 250;

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 rounded-full hover:text-ink">
      {children}
    </button>
  );
}

function OffsetControl({ track, offsetMs }: { track: Track; offsetMs: number }) {
  const setOffset = useLyrics((s) => s.setOffset);
  const label = offsetMs === 0 ? "On time" : `${offsetMs > 0 ? "+" : ""}${(offsetMs / 1000).toFixed(2)}s`;
  return (
    <span className="ml-auto inline-flex items-center gap-1" title="Shift lyric timing if lines appear early or late">
      <button
        type="button"
        aria-label="Show lyrics later"
        onClick={() => setOffset(track.id, offsetMs - OFFSET_STEP)}
        className="grid h-6 w-6 place-items-center rounded-full hover:bg-white/10 hover:text-ink"
      >
        <Minus size={12} weight="bold" />
      </button>
      <button
        type="button"
        onClick={() => setOffset(track.id, 0)}
        className="min-w-16 rounded-full px-1.5 text-center font-mono tabular-nums hover:text-ink"
        title="Reset timing"
      >
        {label}
      </button>
      <button
        type="button"
        aria-label="Show lyrics earlier"
        onClick={() => setOffset(track.id, offsetMs + OFFSET_STEP)}
        className="grid h-6 w-6 place-items-center rounded-full hover:bg-white/10 hover:text-ink"
      >
        <Plus size={12} weight="bold" />
      </button>
    </span>
  );
}

function Message({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col justify-center">
      <p className="text-3xl font-semibold tracking-tight text-ink/80">{title}</p>
      {body && <p className="mt-3 max-w-[46ch] text-sm leading-relaxed text-ink-muted">{body}</p>}
      {children && <div className="mt-6 flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

function ActionButton({ onClick, icon, children, primary }: { onClick: () => void; icon: ReactNode; children: ReactNode; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? "inline-flex h-9 items-center gap-2 rounded-full bg-ink px-4 text-sm font-medium text-[#141416] transition-transform active:scale-[0.97]"
          : "inline-flex h-9 items-center gap-2 rounded-full bg-white/[0.08] px-4 text-sm font-medium transition-[background-color,scale] hover:bg-white/[0.14] active:scale-[0.97]"
      }
    >
      {icon}
      {children}
    </button>
  );
}

export function LyricsPanel({ track }: { track: Track }) {
  const entry = useLyrics((s) => s.byTrack[track.id]);
  const load = useLyrics((s) => s.load);
  const karaoke = usePrefs((s) => s.ui.karaoke);
  const [mode, setMode] = useState<"view" | "search" | "sync">("view");
  useEffect(() => {
    load(track.id);
    setMode("view");
  }, [track.id, load]);
  const refresh = () => load(track.id, true);
  const lyrics = entry?.status === "ready" ? entry.lyrics : undefined;
  const lines = entry?.status === "ready" ? entry.lines : [];
  const syncText = lines.length ? lines.map((l) => l.text).filter(Boolean).join("\n") : (lyrics?.plain ?? "");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={mode}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="min-h-0 flex-1"
        >
          {mode === "search" ? (
            <LyricsSearch track={track} onDone={() => setMode("view")} />
          ) : mode === "sync" ? (
            <LyricsSync track={track} initialText={syncText} onDone={() => setMode("view")} />
          ) : (
            body()
          )}
        </motion.div>
      </AnimatePresence>
      {mode === "view" && lyrics && lyrics.source !== "none" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-6 text-xs text-ink-faint">
          <span>{SOURCE_LABEL[lyrics.source]}</span>
          <LinkButton onClick={() => setMode("search")}>
            <MagnifyingGlass size={13} /> Wrong lyrics?
          </LinkButton>
          <LinkButton onClick={() => setMode("sync")}>
            <Timer size={13} /> {lines.length ? "Re-sync" : "Sync these lyrics"}
          </LinkButton>
          {lyrics.source === "lrclib" && (
            <LinkButton onClick={refresh}>
              <ArrowClockwise size={13} /> Refresh
            </LinkButton>
          )}
          {lines.length > 0 && <OffsetControl track={track} offsetMs={lyrics.offsetMs} />}
        </div>
      )}
    </div>
  );

  function body() {
    if (!entry || entry.status === "loading") {
      return (
        <div className="flex h-full flex-col justify-center gap-5" aria-busy="true" aria-label="Loading lyrics">
          {[78, 62, 84, 55, 70].map((w, i) => (
            <div key={i} className="skeleton h-7 rounded-md" style={{ width: `${w}%` }} />
          ))}
        </div>
      );
    }
    if (entry.status === "error") {
      return (
        <Message title="Couldn't load lyrics" body={entry.error}>
          <ActionButton onClick={refresh} icon={<ArrowClockwise size={16} />}>
            Try again
          </ActionButton>
        </Message>
      );
    }
    const { lyrics } = entry;
    if (lines.length) return <SyncedLyrics lines={lines} offsetMs={lyrics.offsetMs} karaoke={karaoke} />;
    if (lyrics.plain) {
      return (
        <div className="h-full overflow-y-auto pr-4">
          <p className="mb-6 text-xs text-ink-faint">These lyrics aren't time-synced yet.</p>
          <p className="whitespace-pre-line pb-16 text-xl font-medium leading-relaxed text-ink/85">{lyrics.plain}</p>
        </div>
      );
    }
    if (lyrics.instrumental) return <Message title="Instrumental" body="LRCLIB lists this track as having no vocals." />;
    return (
      <Message title="No lyrics found" body="LRCLIB doesn't have this song yet. Search for it by hand, or add and time the lyrics yourself.">
        <ActionButton primary onClick={() => setMode("search")} icon={<MagnifyingGlass size={16} />}>
          Search manually
        </ActionButton>
        <ActionButton onClick={() => setMode("sync")} icon={<Timer size={16} />}>
          Add lyrics
        </ActionButton>
        <ActionButton onClick={refresh} icon={<ArrowClockwise size={16} />}>
          Search again
        </ActionButton>
      </Message>
    );
  }
}
