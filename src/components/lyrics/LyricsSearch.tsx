import { useEffect, useRef, useState, type FormEvent } from "react";
import { CircleNotch, MagnifyingGlass } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { api, type LyricsCandidate, type Track } from "../../lib/api";
import { cn } from "../../lib/cn";
import { formatTime } from "../../lib/format";
import { useLyrics } from "../../store/lyrics";

function Badge({ children, strong }: { children: string; strong?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-px text-[10px] font-medium",
        strong ? "bg-accent text-on-accent" : "bg-white/10 text-ink-muted",
      )}
    >
      {children}
    </span>
  );
}

/** Lets the user pick lyrics from LRCLIB by hand when the automatic match is missing or wrong. */
export function LyricsSearch({ track, onDone }: { track: Track; onDone: () => void }) {
  const [query, setQuery] = useState(`${track.title} ${track.artist}`);
  const [results, setResults] = useState<LyricsCandidate[] | null>(null);
  const [state, setState] = useState<"idle" | "searching" | "error">("idle");
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const put = useLyrics((s) => s.put);

  const run = (q: string) => {
    if (!q.trim()) return;
    setState("searching");
    api
      .lyricsSearch(q.trim())
      .then((r) => {
        // Closest length first: same-length recordings are almost always the right version.
        setResults(r.sort((a, b) => Math.abs(a.duration - track.duration) - Math.abs(b.duration - track.duration)));
        setState("idle");
      })
      .catch((e) => {
        setError(String(e));
        setState("error");
      });
  };

  useEffect(() => {
    input.current?.select();
    run(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(query);
  };

  const choose = (c: LyricsCandidate) => {
    setChoosing(c.id);
    api
      .lyricsChoose(track.id, c.id)
      .then((l) => {
        put(track.id, l);
        onDone();
      })
      .catch((e) => {
        setError(String(e));
        setState("error");
        setChoosing(null);
      });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Find lyrics</h2>
        <button type="button" onClick={onDone} className="rounded-full px-3 py-1 text-sm text-ink-muted hover:bg-white/10 hover:text-ink">
          Cancel
        </button>
      </div>
      <form onSubmit={submit} className="relative mt-4">
        <label htmlFor="lyrics-q" className="sr-only">
          Search LRCLIB
        </label>
        <MagnifyingGlass size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted" />
        <input
          id="lyrics-q"
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          spellCheck={false}
          className="h-11 w-full rounded-full bg-white/[0.08] pl-10 pr-4 text-sm text-ink outline-none ring-1 ring-white/10 placeholder:text-ink-muted focus:ring-white/30"
          placeholder="Song title and artist"
        />
      </form>
      <p className="mt-2 text-xs text-ink-faint">Your file is {formatTime(track.duration)} long. Matches closest to that are listed first.</p>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-2">
        {state === "searching" && (
          <div className="flex items-center gap-2 py-6 text-sm text-ink-muted">
            <CircleNotch size={16} className="animate-spin" /> Searching LRCLIB
          </div>
        )}
        {state === "error" && <p className="py-6 text-sm text-ink-muted">{error}</p>}
        {state === "idle" && results?.length === 0 && (
          <p className="py-6 text-sm text-ink-muted">Nothing found. Try just the song title, or the title with fewer words.</p>
        )}
        {state === "idle" &&
          results?.map((c, i) => {
            const diff = Math.round(c.duration - track.duration);
            return (
              <motion.button
                key={c.id}
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i, 10) * 0.025, duration: 0.3 }}
                disabled={choosing != null}
                onClick={() => choose(c)}
                className="mb-1 block w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07] disabled:opacity-50"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{c.trackName}</span>
                  {c.wordSync && <Badge strong>Word sync</Badge>}
                  {c.synced ? <Badge>Synced</Badge> : c.plain ? <Badge>Plain</Badge> : c.instrumental ? <Badge>Instrumental</Badge> : null}
                  {choosing === c.id && <CircleNotch size={14} className="animate-spin text-ink-muted" />}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
                  <span className="truncate">
                    {c.artistName}
                    {c.albumName ? `, ${c.albumName}` : ""}
                  </span>
                  <span className={cn("ml-auto shrink-0 font-mono tabular-nums", Math.abs(diff) <= 2 && "text-accent")}>
                    {formatTime(c.duration)}
                    {diff !== 0 && ` (${diff > 0 ? "+" : ""}${diff}s)`}
                  </span>
                </div>
                {c.preview && <p className="mt-1 truncate text-xs italic text-ink-faint">{c.preview}</p>}
              </motion.button>
            );
          })}
      </div>
    </div>
  );
}
